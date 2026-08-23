export function nextStoreRevision(store, previousRevision = 0) {
  return {
    ...store,
    storeRevision: Math.max(0, Math.round(Number(previousRevision) || 0)) + 1
  };
}

export function isPromiseLike(value) {
  return Boolean(value && typeof value.then === 'function');
}

export function isBlobWriteConflict(error) {
  return error?.name === 'BlobPreconditionFailedError' || Number(error?.statusCode) === 412;
}

export function blobWriteConflictAttempts(value = process.env.BLOB_WRITE_CONFLICT_ATTEMPTS) {
  const configured = Number(value);
  if (!Number.isFinite(configured)) return 3;
  return Math.min(10, Math.max(1, Math.round(configured)));
}
