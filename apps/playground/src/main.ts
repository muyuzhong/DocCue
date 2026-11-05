import { createBridge } from '@doccue/bridge';
import { startApp } from './app.js';
import { startAssistant } from './assistant.js';
import './style.css';

// One line of integration: the bridge records what the user does from here on.
const bridge = createBridge({ endpoint: '/doccue', user: { attributes: { role: '新用户', plan: '试用版' } } });

startApp();
startAssistant(bridge);
