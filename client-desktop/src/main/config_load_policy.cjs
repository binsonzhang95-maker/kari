function shouldUseLegacyConfigFallback({ sqliteExists, sqliteReadFailed, sqliteStored } = {}) {
  if (sqliteStored) return false;
  if (sqliteExists && sqliteReadFailed) return false;
  return true;
}

function isMissingAppConfigTableError(error) {
  const message = String(error && error.message ? error.message : error || '');
  return /no such table:\s*AppConfig/i.test(message);
}

module.exports = {
  shouldUseLegacyConfigFallback,
  isMissingAppConfigTableError,
};
