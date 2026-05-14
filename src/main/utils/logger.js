function now() {
  return new Date().toISOString();
}

function log(level, message, meta = {}) {
  const payload = {
    ts: now(),
    level,
    message,
    ...meta
  };
  console.log(JSON.stringify(payload));
}

module.exports = {
  info: (message, meta) => log('info', message, meta),
  warn: (message, meta) => log('warn', message, meta),
  error: (message, meta) => log('error', message, meta)
};
