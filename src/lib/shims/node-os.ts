/** Browser shim for Node's `os` module (gramjs reads device info at startup). */
export const type = () => "Browser";
export const release = () => "1.0";
export const platform = () => "browser";
export const arch = () => "web";
export const hostname = () => "localhost";
export const EOL = "\n";
export const tmpdir = () => "/tmp";

export default { type, release, platform, arch, hostname, EOL, tmpdir };
