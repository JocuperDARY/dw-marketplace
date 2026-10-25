// Inspected pinned SDK/Bridge settings, shared by every capability profile.
// These are implementation boundaries, never human spending authorization.
export const commonImplementationConstraints = Object.freeze([
  'Pinned SDK 0.2.1-rc.2 supplies a 256000 output-token default and 1000000 context setting. These are SDK adapter settings, not verified provider hard maxima; inspect recorded reservations for actual requests.',
  'SDK initialization is bounded at 30 seconds, teardown at 1/3/2 seconds. Bridge prompt storage is 64 KiB, stage JSON 32 KiB and retained text 1 MiB. File/tool output paging remains. These are implementation boundaries, not task spending authorization.',
]);
