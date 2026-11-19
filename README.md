# Knutsford Tea

A dark, anonymous campus gossip feed for Knutsford University. Students can post campus tea, reply to posts, and react; updates appear across open clients every six seconds.

## Run locally

Requires Node.js 20 or newer.

```sh
npm install
npm start
```

Open `http://localhost:3000`. Without `DATABASE_URL`, the app uses in-memory storage for local previews; posts disappear when the server restarts.

## Deploy on Render

1. Push this project to a Git repository.
2. In Render, choose **New → Blueprint**, then select the repository.
3. Render reads `render.yaml` to create the Node web service and PostgreSQL database. The database is required for persistent posts and sharing data across service instances.

The web service uses `npm install` and `npm start`. Render supplies `PORT` and `DATABASE_URL`; the app creates its tables on startup.

## Community

Posts and comments are anonymous and limited in length. The interface asks users not to share names or personal information, doxx, or bully. Avoid posting private or identifying details.
