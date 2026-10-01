// Obsidian patches a few helpers onto built-in prototypes; the plugin relies on them.
declare global {
	interface String {
		contains(target: string): boolean;
	}
}

if (!String.prototype.contains) {
	String.prototype.contains = function (this: string, target: string): boolean {
		return this.includes(target);
	};
}

export {};
