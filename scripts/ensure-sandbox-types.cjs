const fs = require("fs");
const path = require("path");

const pkgDir = path.join(__dirname, "..", "node_modules", "@anthropic-ai", "sandbox-runtime");
const distDir = path.join(pkgDir, "dist");
const indexDts = path.join(distDir, "index.d.ts");
const indexJs = path.join(distDir, "index.js");

if (fs.existsSync(indexDts) && fs.existsSync(indexJs)) {
  process.exit(0);
}

fs.mkdirSync(distDir, { recursive: true });

fs.writeFileSync(
  indexDts,
  `export interface FsReadRestrictionConfig {
  denyOnly: string[];
  allowWithinDeny?: string[];
}

export interface FsWriteRestrictionConfig {
  allowOnly: string[];
  denyWithinAllow: string[];
}

export interface NetworkRestrictionConfig {
  allowedHosts?: string[];
  deniedHosts?: string[];
}

export interface SandboxRuntimeConfig {
  filesystem?: {
    denyRead?: string[];
    allowRead?: string[];
    allowWrite?: string[];
    denyWrite?: string[];
    allowGitConfig?: boolean;
  };
  network?: {
    allowedDomains?: string[];
    deniedDomains?: string[];
    allowUnixSockets?: string[];
    allowAllUnixSockets?: boolean;
    allowLocalBinding?: boolean;
    httpProxyPort?: number;
    socksProxyPort?: number;
  };
  windows?: {
    groupName: string;
    groupSid?: string;
    wfpSublayerGuid?: string;
    proxyPortRange?: [number, number];
  };
  ignoreViolations?: Record<string, string[]>;
  enableWeakerNestedSandbox?: boolean;
  enableWeakerNetworkIsolation?: boolean;
  allowAppleEvents?: boolean;
}

export interface ISandboxManager {
  initialize(runtimeConfig: SandboxRuntimeConfig, sandboxAskCallback?: unknown, enableLogMonitor?: boolean): Promise<void>;
  isSupportedPlatform(): boolean;
  isSandboxingEnabled(): boolean;
  getFsReadConfig(): FsReadRestrictionConfig;
  getFsWriteConfig(): FsWriteRestrictionConfig;
  getNetworkRestrictionConfig(): NetworkRestrictionConfig;
  wrapWithSandbox(command: string, binShell?: string, customConfig?: Partial<SandboxRuntimeConfig>, abortSignal?: AbortSignal): Promise<string>;
  reset(): Promise<void>;
}

export declare const SandboxManager: ISandboxManager;
`
);

fs.writeFileSync(
  indexJs,
  `export const SandboxManager = {
  async initialize() {},
  isSupportedPlatform() { return false; },
  isSandboxingEnabled() { return false; },
  getFsReadConfig() { return { denyOnly: [], allowWithinDeny: [] }; },
  getFsWriteConfig() { return { allowOnly: [], denyWithinAllow: [] }; },
  getNetworkRestrictionConfig() { return {}; },
  async wrapWithSandbox(cmd) { return cmd; },
  async reset() {},
};
`
);
