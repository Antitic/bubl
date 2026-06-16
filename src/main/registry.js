'use strict';

/**
 * Global lookup from a tab WebContents id to its owning window controller and
 * tab record. The adblocker (which sees raw webRequest details across all
 * sessions) uses this to resolve the initiating tab's hostname and to route
 * blocked-counter updates back to the correct renderer.
 */
const byWebContentsId = new Map();

function register(webContentsId, controller, tab) {
  byWebContentsId.set(webContentsId, { controller, tab });
}

function unregister(webContentsId) {
  byWebContentsId.delete(webContentsId);
}

function get(webContentsId) {
  return byWebContentsId.get(webContentsId);
}

module.exports = { register, unregister, get };
