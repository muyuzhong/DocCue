# DocCue on a plain page

The smallest setup: Node's own `http` server on the backend, an import map on the frontend, no build step. The app is a members page with an invite form that refuses some email domains; its docs say why.

```bash
npm install
cp .env.example .env   # your model key
npm start              # http://localhost:3000
```

Try inviting `bob@gmail.com`, then ask the assistant (bottom right) "Why can't I invite bob@gmail.com?". It reads the error and the docs, then points at the allowed domains, the save button and the invite form in turn.

What DocCue adds is in two places:

- `server.js`: `createHandler` with a model and the docs folder, mounted at `/doccue`.
- `index.html`: the import map and two lines, `createBridge` and `mount`.
