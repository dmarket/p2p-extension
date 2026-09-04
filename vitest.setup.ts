import { beforeEach } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';

// The fake extension API is a module singleton: storage contents, registered listeners and installed
// event state all survive from one test to the next. Reset before each so a test that writes
// `activation.enabled` cannot decide the outcome of the next one.
beforeEach(() => {
  fakeBrowser.reset();
});
