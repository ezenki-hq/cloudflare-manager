interface ImportMetaEnv {
  readonly VITE_BACKEND_IMAGE?: string;
  readonly VITE_RUNNER_IMAGE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare module "*.css";
