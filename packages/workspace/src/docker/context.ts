import type { DockerInvoker } from "./invoke.js";

/** Validated, normalized Docker driver state shared by extracted operations. */
export interface DockerModuleContext {
  readonly invoke: DockerInvoker;
  readonly dockerBinary: string;
  readonly dockerStatsSocketPath: string | undefined;
  readonly image: string;
  readonly runtime: string | undefined;
  readonly volumeDriver: string | undefined;
  readonly volumeOptions: Readonly<Record<string, string>>;
  readonly egressProxyContainer: string | undefined;
  readonly egressProxyPort: number;
  readonly egressProxySecret: string | undefined;
  readonly gitInternalContainer: string | undefined;
  readonly gitInternalNetwork: string;
  readonly gitInternalPort: number;
  readonly gitInternalTokenSecret: string | undefined;
  readonly gitFetcherImage: string;
}
