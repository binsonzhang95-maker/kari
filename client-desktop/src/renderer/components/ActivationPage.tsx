import { FormEvent, useEffect, useRef, useState } from 'react';
import { ArrowRight, KeyRound, Link2, ShieldCheck } from 'lucide-react';
import type { SavedConfig } from '../../shared/types';
import { APP_COPYRIGHT, APP_VERSION } from '../../shared/appMeta';
import { useI18n } from '../i18n';

interface ActivationPageProps {
  onActivated: (config: SavedConfig, message?: string) => void;
}

export function ActivationPage({ onActivated }: ActivationPageProps) {
  const { t } = useI18n();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [serverAddr, setServerAddr] = useState('');
  const [activationCode, setActivationCode] = useState('');
  const [machineLabel, setMachineLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    let width = 0;
    let height = 0;
    let frame = 0;
    let raf = 0;
    const glyphs = 'KARI01SYNCPTYFRPCODEXCLAUDECONTINUE';
    const drops: number[] = [];

    const resize = () => {
      width = canvas.clientWidth;
      height = canvas.clientHeight;
      canvas.width = Math.floor(width * window.devicePixelRatio);
      canvas.height = Math.floor(height * window.devicePixelRatio);
      ctx.setTransform(window.devicePixelRatio, 0, 0, window.devicePixelRatio, 0, 0);
      const cols = Math.ceil(width / 18);
      drops.length = cols;
      for (let i = 0; i < cols; i++) drops[i] = Math.random() * height;
    };

    const tick = () => {
      frame++;
      ctx.fillStyle = 'rgba(5, 7, 10, 0.18)';
      ctx.fillRect(0, 0, width, height);
      ctx.font = '13px JetBrains Mono, ui-monospace, SFMono-Regular, Menlo, monospace';
      for (let i = 0; i < drops.length; i++) {
        const x = i * 18;
        const y = drops[i];
        const char = glyphs[(Math.floor(Math.random() * glyphs.length) + frame + i) % glyphs.length];
        ctx.fillStyle = i % 7 === 0 ? 'rgba(181, 139, 70, 0.78)' : 'rgba(118, 92, 48, 0.58)';
        ctx.fillText(char, x, y);
        drops[i] = y > height + Math.random() * 400 ? 0 : y + 12 + Math.random() * 10;
      }
      ctx.strokeStyle = 'rgba(181, 139, 70, 0.08)';
      for (let y = 0; y < height; y += 48) {
        ctx.beginPath();
        ctx.moveTo(0, y + ((frame * 0.5) % 48));
        ctx.lineTo(width, y + ((frame * 0.5) % 48));
        ctx.stroke();
      }
      raf = requestAnimationFrame(tick);
    };

    resize();
    tick();
    window.addEventListener('resize', resize);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
    };
  }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const result = await window.kari.activate({ serverAddr, activationCode, machineLabel });
      onActivated(result.config, result.message);
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="activation-page">
      <canvas ref={canvasRef} className="matrix-canvas" />
      <div className="activation-grid">
        <div className="activation-copy">
          <h1>{t('activation.title')}</h1>
          <div className="cli-marquee" aria-hidden="true">
            <div>
              <span>$ kari cloud workspace attach</span>
              <span>$ claude --resume latest</span>
              <span>$ codex resume --remote</span>
              <span>$ sync status --live</span>
            </div>
          </div>
          <p>{t('activation.description')}</p>
          <div className="signal-row">
            <span><ShieldCheck size={15} /> {t('activation.signalReady')}</span>
            <span><Link2 size={15} /> {t('activation.signalWorkspace')}</span>
            <span><KeyRound size={15} /> {t('activation.signalResume')}</span>
          </div>
        </div>
        <form className="activation-panel" onSubmit={submit}>
          <div className="panel-scanline" />
          <label>
            <span>Server address</span>
            <input
              value={serverAddr}
              onChange={(event) => setServerAddr(event.target.value)}
              placeholder="host:8443"
              spellCheck={false}
              required
            />
          </label>
          <label>
            <span>Shared secret</span>
            <input
              value={activationCode}
              onChange={(event) => setActivationCode(event.target.value)}
              placeholder="your KARI_SECRET"
              type="password"
              spellCheck={false}
              required
            />
          </label>
          <label>
            <span>{t('activation.machineLabel')}</span>
            <input
              value={machineLabel}
              onChange={(event) => setMachineLabel(event.target.value)}
              placeholder={t('activation.machinePlaceholder')}
              spellCheck={false}
            />
          </label>
          {error && <div className="activation-error">{error}</div>}
          <button className="primary-action" disabled={busy}>
            <span>{busy ? t('activation.entering') : t('activation.submit')}</span>
            <ArrowRight size={18} />
          </button>
        </form>
      </div>
      <div className="activation-footer">
        <span>v{APP_VERSION}</span>
        <span>{APP_COPYRIGHT}</span>
      </div>
    </section>
  );
}
