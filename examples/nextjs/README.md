# DocCue in a Next.js app

The App Router version of the [basic example](../basic): the same members page, with DocCue added in two files.

```bash
npm install
cp .env.example .env.local   # your model key
npm run dev                  # http://localhost:3000
```

Try inviting `bob@gmail.com`, then ask the assistant (bottom right) "Why can't I invite bob@gmail.com?".

- `app/doccue/[...path]/route.ts`: the backend. `createHandler` is a Fetch handler, so the route's `POST` just calls it. It runs on the Node.js runtime because it reads the `docs` folder.
- `app/doccue.tsx`: the frontend, a client component in the root layout that creates the bridge once for the life of the page and mounts its chat panel.

The handler is open to anyone who reaches it and calls your model: in a real app, check your own session in the route (and pass what must hold, like the user's role, as `createHandler`'s `user`) and rate-limit it.
