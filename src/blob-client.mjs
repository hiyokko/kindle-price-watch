let blobSdkPromise;

export function hasBlobConfig() {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN);
}

export function getBlobSdk() {
  blobSdkPromise ||= import('@vercel/blob');
  return blobSdkPromise;
}
