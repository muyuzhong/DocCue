import { createBridge, type Bridge } from '@doccue/bridge';
import { startApp } from './app.js';
import { startAssistant } from './assistant.js';
import './style.css';

// One line of integration: the bridge records what the user does from here on.
const user = { role: '新用户', plan: '试用版' };
const bridge = createBridge({ endpoint: '/doccue', user });

// For tests and for poking at it from the browser console.
(window as unknown as { doccue: Bridge }).doccue = bridge;

startApp();
startAssistant(bridge, user);
