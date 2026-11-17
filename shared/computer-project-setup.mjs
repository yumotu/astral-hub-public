/** Cached names never identify the desktop whose directory picker may be used. */
export function matchesLocalProjectComputer(target, status, server) {
  return (
    target?.origin === 'computer' &&
    typeof target.deviceId === 'string' &&
    !!target.deviceId &&
    status?.configured === true &&
    status.deviceId === target.deviceId &&
    typeof status.server === 'string' &&
    status.server.replace(/\/$/, '') === server.replace(/\/$/, '')
  );
}
