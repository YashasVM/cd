import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const clerk = loadEnv(mode, process.cwd(), 'CLERK_PUBLISHABLE_KEY');
  const vite = loadEnv(mode, process.cwd(), 'VITE_CLERK_PUBLISHABLE_KEY');
  return { define: { 'import.meta.env.VITE_CLERK_PUBLISHABLE_KEY': JSON.stringify(vite.VITE_CLERK_PUBLISHABLE_KEY || clerk.CLERK_PUBLISHABLE_KEY) } };
});
