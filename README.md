This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Custom Sandbox Image

Vibe Harness uses a custom Docker sandbox template that extends the official Copilot CLI image with pre-installed development tools:

- **Node.js 25** (with npm)
- **pnpm** (via corepack)
- **Python 3.14**
- **uv / uvx** (Astral Python package manager)

### Building the image

```bash
./docker/build.sh
# or manually:
docker build -t vibe-harness/copilot:latest -f docker/Dockerfile.copilot docker/
```

The default agent definition references `vibe-harness/copilot:latest`. Docker's `--pull-template missing` policy (the default) will find the locally-built image without trying to pull from a registry.

### Rebuilding after changes

Edit `docker/Dockerfile.copilot` and re-run the build script. Delete `vibe-harness.db` if you need to re-seed the default agent definition, or update the agent's `dockerImage` field via the API.

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
