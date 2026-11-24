import baseSharp from "sharp";

// Atrium re-encodes one cover or thumbnail at a time, on a user action. libvips' default
// keeps a 50 MB operation cache and starts a worker thread per core; neither pays off here
// and both stay resident, so turn the cache off and run one thread.
baseSharp.cache(false);
baseSharp.concurrency(1);

export const sharp = baseSharp;
