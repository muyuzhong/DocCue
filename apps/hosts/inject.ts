/**
 * What a host app adds to its frontend to use DocCue: the bridge and its built-in chat panel.
 * The proxy bundles this file from the built package (`dist`) and puts it on every HTML page of
 * the app, as if the app's own bundle included it.
 */
import { createBridge, type Bridge } from '@doccue/bridge';

const bridge = createBridge({ endpoint: '/doccue' });
void bridge.mount();

// For the scripts that drive the page, and for poking at it from the browser console.
(window as unknown as { doccue: Bridge }).doccue = bridge;
