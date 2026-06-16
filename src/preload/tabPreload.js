'use strict';

// Minimal, intentionally empty preload for tab web content. Web pages run with
// context isolation and sandboxing; Bubl injects no privileged API into them.
// Kept as a dedicated file so the security boundary is explicit and so future
// per-page features (e.g. find-in-page bridges) have a home.
