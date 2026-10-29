/**
 * THE WORK ONEDRIVE (OneDrive wave, 2026-10-27): finds the folder the
 * OneDrive client syncs for the user's work or school account, so
 * Settings › Storage can offer to keep the library there. Cairn never talks
 * to OneDrive itself — the client on the machine does the syncing.
 *
 *   Windows  %OneDriveCommercial% (the client sets it), else the first
 *            "~/OneDrive - <Organization>" folder.
 *   macOS    "~/Library/CloudStorage/OneDrive-<Organization>" (the File
 *            Provider location), else a legacy "~/OneDrive - <Organization>".
 *
 * Personal OneDrive and synced SharePoint libraries are never offered: a
 * work library belongs in the work account.
 *
 * The probe is injectable so tests cover every layout on any host.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface OneDriveProbe {
	platform: NodeJS.Platform;
	env: Record<string, string | undefined>;
	home: string;
	listDir(dir: string): string[];
	isDir(dir: string): boolean;
}

export interface WorkOneDrive {
	root: string;
	/** As File Explorer / Finder names it, e.g. "OneDrive - Contoso". */
	label: string;
}

export function systemProbe(): OneDriveProbe {
	return {
		platform: process.platform,
		env: process.env,
		home: os.homedir(),
		listDir: (dir) => {
			try {
				return fs.readdirSync(dir);
			} catch {
				return [];
			}
		},
		isDir: (dir) => {
			try {
				return fs.statSync(dir).isDirectory();
			} catch {
				return false;
			}
		},
	};
}

/** "OneDrive - Contoso" folders in `dir` (never "OneDrive - Personal"). */
function workFolders(probe: OneDriveProbe, p: path.PlatformPath, dir: string): string[] {
	return probe
		.listDir(dir)
		.filter((name) => /^OneDrive - .+/.test(name) && name !== "OneDrive - Personal")
		.sort()
		.map((name) => p.join(dir, name))
		.filter((full) => probe.isDir(full));
}

export function detectWorkOneDrive(probe: OneDriveProbe = systemProbe()): WorkOneDrive | null {
	if (probe.platform === "win32") {
		const p = path.win32;
		const fromEnv = probe.env.OneDriveCommercial;
		if (fromEnv && p.isAbsolute(fromEnv) && probe.isDir(fromEnv)) {
			const root = p.normalize(fromEnv).replace(/[\\/]+$/, "");
			return { root, label: p.basename(root) };
		}
		const [found] = workFolders(probe, p, probe.home);
		return found ? { root: found, label: p.basename(found) } : null;
	}
	if (probe.platform === "darwin") {
		const p = path.posix;
		const cloud = p.join(probe.home, "Library", "CloudStorage");
		for (const name of probe.listDir(cloud).sort()) {
			const org = /^OneDrive-(.+)$/.exec(name)?.[1];
			if (!org || org === "Personal" || org.startsWith("SharedLibraries-")) continue;
			const root = p.join(cloud, name);
			if (probe.isDir(root)) return { root, label: `OneDrive - ${org}` };
		}
		const [legacy] = workFolders(probe, p, probe.home);
		return legacy ? { root: legacy, label: p.basename(legacy) } : null;
	}
	return null;
}

/** Where the library goes in a OneDrive: its Apps folder, like any app's. */
export function oneDriveLibraryPath(root: string, platform: NodeJS.Platform = process.platform): string {
	return (platform === "win32" ? path.win32 : path.posix).join(root, "Apps", "Cairn");
}
