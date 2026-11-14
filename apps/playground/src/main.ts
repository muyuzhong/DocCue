import { createBridge, type Bridge } from '@doccue/bridge';
import { startApp } from './app.js';
import { startDebug } from './debug.js';
import './style.css';

// The integration: the bridge records what the user does from here on, and mount() puts the
// built-in chat panel in the corner.
const user = { role: '新用户', plan: '试用版' };
const bridge = createBridge({ endpoint: '/doccue', user });
void bridge.mount();

// For tests and for poking at it from the browser console.
(window as unknown as { doccue: Bridge }).doccue = bridge;

startApp();
startDebug(bridge, user);
