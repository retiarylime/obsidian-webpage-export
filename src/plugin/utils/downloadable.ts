import { ExportPipelineOptions } from "src/plugin/website/pipeline-options.js";
import { Path } from "./path";
import { FileStats, TFile } from "obsidian";

export class Attachment
{
	/**
	 * The raw data of the file
	 */
	private _data: string | Buffer;
	private _source: TFile | null;
	private _sourcePath: string | undefined;
	private _sourcePathRootRelative: string | undefined;
	private _targetPath: Path;
	public sourceStat: FileStats;
	public exportOptions: ExportPipelineOptions;
	public showInTree: boolean = false;
	public treeOrder: number = 0;

	public get filename() { return this.targetPath.fullName; }
	public get basename() { return this.targetPath.basename; }
	public get extension() { return this.targetPath.extension; }
	public get extensionName() { return this.targetPath.extensionName; }
	public get sourcePath() { return this._sourcePath; }
	public set sourcePath(source: string | undefined)
	{
		this._sourcePath = source;
		this._sourcePathRootRelative = this.removeRootFromPath(new Path(source ?? ""), false).path;
	}
	public get sourcePathRootRelative() { return this._sourcePathRootRelative;};
	public set source(source: TFile | null)
	{
		this._source = source;
		this.sourceStat = source?.stat ?? { ctime: Date.now(), mtime: Date.now(), size: this.data?.length ?? 0 };
		this.sourcePath = source?.path;
	}
	public get source() { return this._source; }
	public get targetPath() { return this._targetPath; }
	public set targetPath(target: Path)
	{
		console.log(`[Downloadable] targetPath setter called with: "${target.path}"`);
		target.slugify(this.exportOptions.slugifyPaths);
		console.log(`[Downloadable] After slugify: "${target.path}"`);
		target = this.removeRootFromPath(target);
		console.log(`[Downloadable] After removeRootFromPath: "${target.path}"`);
		this._targetPath = target;
	}

	public get data() { return this._data; }
	public set data(data: string | Buffer)
	{
		this._data = data;
		if (!this.source) this.sourceStat = { ctime: Date.now(), mtime: Date.now(), size: this.data?.length ?? 0 };
	}


	constructor(data: string | Buffer, target: Path, source: TFile | undefined | null, options: ExportPipelineOptions)
	{
		// @ts-ignore
		if (target.extensionName == "html" && !Object.getPrototypeOf(this).constructor.name.contains("Webpage"))	target.setFileName(target.basename + "-content");
		if (target.isDirectory) throw new Error("target must be a file: " + target.path);
		if (target.isAbsolute) throw new Error("(absolute) Target must be a relative path with the working directory set to the root: " + target.path);
		this.exportOptions = options;
		this.source = source ?? null;
		this.data = data;
		this.targetPath = target;
	}

	private removeRootFromPath(path: Path, allowSlugify: boolean = true)
	{
		// DEBUG: Log the removal process
		console.log(`[Downloadable] removeRootFromPath called:`);
		console.log(`  Input path: "${path.path}"`);
		console.log(`  Export root: "${this.exportOptions.exportRoot ?? 'EMPTY'}"`);
		
		// ✅ FIX: When export root is empty, don't remove anything - preserve full directory structure
		if (!this.exportOptions.exportRoot || this.exportOptions.exportRoot === '') {
			console.log(`  🔧 EMPTY EXPORT ROOT - Preserving full directory structure`);
			console.log(`  ✅ PRESERVING: "${path.path}"`);
			return path;
		}
		
		// remove the export root from the target path (original behavior when export root is set)
		const root = new Path(this.exportOptions.exportRoot ?? "").slugify(allowSlugify && this.exportOptions.slugifyPaths).path + "/";
		console.log(`  Processed root: "${root}"`);
		
		if (path.path.startsWith(root))
		{
			const originalPath = path.path;
			const newPath = path.path.substring(root.length);
			path.reparse(newPath);
			console.log(`  ❌ STRIPPED: "${originalPath}" -> "${newPath}"`);
		}
		else
		{
			console.log(`  ✅ NO STRIPPING: path doesn't start with root`);
		}
		
		console.log(`  Final path: "${path.path}"`);
		return path;
	}

	async download()
	{
		if (this.targetPath.workingDirectory == Path.vaultPath.path)
		{ 
			throw new Error("(working dir) Target should be a relative path with the working directory set to the root: " + this.targetPath.absoluted().path);
		}

		const data = this.data instanceof Buffer ? new Uint8Array(this.data) : new Uint8Array(Buffer.from(this.data.toString()));
		await this.targetPath.write(data);
	}
}
