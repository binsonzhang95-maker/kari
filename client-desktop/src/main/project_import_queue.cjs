'use strict';

function createProjectImportQueue({ store, processJob, onChange, onProgress, logger, concurrency } = {}) {
  if (!store) throw new Error('project_import_queue: store is required');
  if (typeof processJob !== 'function') throw new Error('project_import_queue: processJob is required');
  const reportProgress = typeof onProgress === 'function' ? onProgress : null;
  // How many jobs may PROCESS at once. Claims stay serialized regardless (see
  // claimNextSerialized) so two workers can never grab the same row. Defaults
  // to 1 (deterministic for unit tests); the app passes 2–3.
  const maxConcurrent = Math.max(1, Number(concurrency) || 1);

  const log = logger && typeof logger.warn === 'function'
    ? logger
    : { warn: (msg) => console.warn('[project-import-queue]', msg) };
  const notify = typeof onChange === 'function' ? onChange : () => {};

  let started = false;
  let dispatching = false;     // a claim loop is currently running
  let activeCount = 0;         // jobs currently in processJob
  let idleWaiters = [];        // resolved whenever activeCount/dispatching changes

  function notifyIdle() {
    const waiters = idleWaiters;
    idleWaiters = [];
    for (const resolve of waiters) resolve();
  }

  async function start() {
    if (started) return;
    started = true;
    await store.recoverInterrupted();
    await emitChange();
    void dispatch();
  }

  async function enqueue(input) {
    if (!started) await start();
    const job = await store.enqueue(input);
    await emitChange();
    void dispatch(); // kick a claim; fills a free slot if one exists
    return job;
  }

  // dispatch fills every free concurrency slot with a claimed job, then returns.
  // Re-entered on each enqueue and on each job completion, so a freed slot is
  // refilled immediately — a slow/offline-peer job occupying one slot never
  // blocks the others. The `dispatching` guard keeps a single claim loop, and
  // claimNextSerialized keeps claims atomic on top of that.
  async function dispatch() {
    if (dispatching) return;
    dispatching = true;
    try {
      while (activeCount < maxConcurrent) {
        const job = await claimNextSerialized();
        if (!job) break;
        activeCount += 1;
        // Free the slot on BOTH settle paths. runJob has its own try/catch and
        // should never reject, but a best-effort emitChange outside that catch
        // theoretically could — if it did and we only freed on fulfillment, the
        // slot would leak forever and drain() would hang.
        const onSettled = () => {
          activeCount -= 1;
          notifyIdle();
          void dispatch();
        };
        void runJob(job).then(onSettled, (err) => {
          log.warn(`runJob unexpectedly rejected for ${job.id}: ${String(err && err.message || err)}`);
          onSettled();
        });
      }
    } finally {
      dispatching = false;
      notifyIdle();
    }
  }

  // Serialize claimNext across workers. store.claimNext() is a SELECT-then-
  // UPDATE across awaits and is NOT atomic on its own, so two concurrent
  // claims could grab the same queued row. Chaining guarantees one claim
  // completes before the next begins.
  let claimChain = Promise.resolve();
  function claimNextSerialized() {
    const next = claimChain.then(() => store.claimNext());
    claimChain = next.then(() => undefined, () => undefined);
    return next;
  }

  async function runJob(job) {
    await emitChange();
    try {
      let markedUploading = false;
      const stage = {
        markUploading: async () => {
          if (markedUploading) return;
          markedUploading = true;
          if (typeof store.markUploading === 'function') {
            await store.markUploading(job.id);
            await emitChange();
          }
        },
        // Ephemeral live progress (scan%/completion%). The caller stashes it in
        // an in-memory map; we then broadcast through the SAME ordered
        // emitChange path as state changes, so a progress tick can never land
        // after the terminal success broadcast and revive the "migrating" row.
        onProgress: (progress) => {
          if (reportProgress) {
            try { reportProgress(job.id, progress); } catch (err) {
              log.warn(`progress report for ${job.id} threw: ${String(err && err.message || err)}`);
            }
          }
          void emitChange();
        },
      };
      await processJob(job, stage);
      await store.markSucceeded(job.id);
      await emitChange();
    } catch (err) {
      const message = String(err && err.message ? err.message : err);
      log.warn(`job ${job.id} failed: ${message}`);
      const failedJob = await store.markFailed(job.id, message);
      await emitChange({ failedJob });
    }
  }

  async function snapshot() {
    return store.listActive();
  }

  // Serialize broadcasts in call order. Both job-state changes and progress
  // ticks emit through here; without serialization a progress emit's async
  // snapshot could land AFTER a later success emit, re-broadcasting the job as
  // still-active and leaving the UI stuck on "migrating" until a manual refetch.
  let emitChain = Promise.resolve();
  function emitChange(event) {
    emitChain = emitChain.then(async () => {
      const active = await snapshot().catch(() => []);
      // A throwing onChange (e.g. a renderer broadcast error) must never reject
      // the pump — that would leak a concurrency slot and hang drain().
      try {
        notify(active, event || null);
      } catch (err) {
        log.warn(`onChange threw: ${String(err && err.message || err)}`);
      }
    }).catch(() => {});
    return emitChain;
  }

  // drain resolves once the queue is fully idle: no job processing and no claim
  // loop in flight (a freshly enqueued job sets dispatching synchronously before
  // its first await, so it's observed here).
  async function drain() {
    while (activeCount > 0 || dispatching) {
      await new Promise((resolve) => idleWaiters.push(resolve));
    }
  }

  async function waitForIdleTick() {
    if (activeCount === 0 && !dispatching) return;
    await new Promise((resolve) => idleWaiters.push(resolve));
  }

  return {
    start,
    enqueue,
    snapshot,
    drain,
    waitForIdleTick,
  };
}

module.exports = {
  createProjectImportQueue,
};
