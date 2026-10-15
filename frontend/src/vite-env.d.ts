interface ImportMetaEnv {
  readonly VITE_BACKEND_ORIGIN?: string;
  readonly VITE_BACKEND_IMAGE?: string;
  readonly VITE_RUNNER_IMAGE?: string;
  readonly VITE_CF_CLIENT_ID?: string;
  readonly VITE_PUBLIC_ORIGIN?: string;
  readonly VITE_COMMANDER_ORIGIN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare module "*.css";
