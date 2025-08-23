import { Notice, TFile, TFolder } from "obsidian";
import { Path } from "src/plugin/utils/path";
import { ExportPreset, Settings, SettingsPage } from "src/plugin/settings/settings";
import { Utils } from "src/plugin/utils/utils";
import { Website } from "src/plugin/website/website";
import { ExportLog, MarkdownRendererAPI } from "src/plugin/render-api/render-api";
import { ExportInfo, ExportModal } from "src/plugin/settings/export-modal";
import { Webpage } from "./website/webpage";
import { ChunkedWebsiteExporter } from "./utils/chunked-website-exporter";

export class HTMLExporter
{
	static async updateSettings(usePreviousSettings: boolean = false, overrideFiles: TFile[] | undefined = undefined, overrideExportPath: Path | undefined = undefined): Promise<ExportInfo | undefined>
	{
		if (!usePreviousSettings) 
		{
			const modal = new ExportModal();
			if(overrideFiles) modal.overridePickedFiles(overrideFiles);
			return await modal.open();
		}
		
		const files = Settings.exportOptions.filesToExport[0];
		const path = overrideExportPath ?? new Path(Settings.exportOptions.exportPath);

		if ((files.length == 0 && overrideFiles == undefined) || !path.exists || !path.isAbsolute || !path.isDirectory)
		{
			new Notice("Please set the export path and files to export in the settings first.", 5000);
			const modal = new ExportModal();
			if(overrideFiles) modal.overridePickedFiles(overrideFiles);
			return await modal.open();
		}

		return undefined;
	}

	public static async export(usePreviousSettings: boolean = true, overrideFiles: TFile[] | undefined = undefined, overrideExportPath: Path | undefined = undefined)
	{
		const info = await this.updateSettings(usePreviousSettings, overrideFiles, overrideExportPath);
		if ((!info && !usePreviousSettings) || (info && info.canceled)) return;

		const files = info?.pickedFiles ?? overrideFiles ?? Settings.getFilesToExport();
		const exportPath = overrideExportPath ?? info?.exportPath ?? new Path(Settings.exportOptions.exportPath);

		const website = await HTMLExporter.exportFiles(files, exportPath, true, Settings.deleteOldFiles);

		if (!website) return;
		if (Settings.openAfterExport) Utils.openPath(exportPath);
		new Notice("✅ Finished HTML Export:\n\n" + exportPath, 5000);
	}

	public static async exportFiles(files: TFile[], destination: Path, saveFiles: boolean, deleteOld: boolean) : Promise<Website | undefined>
	{
		// Check if we should use chunked export for large file sets
		if (ChunkedWebsiteExporter.shouldUseChunkedExport(files))
		{
			ExportLog.log(`📦 Large vault detected (${files.length} files) - using chunked export`);
			
			// Begin batch processing exactly like the original exporter for identical behavior
			MarkdownRendererAPI.beginBatch();
			let website = undefined;
			try
			{
				website = await ChunkedWebsiteExporter.exportInChunks(files, destination);
				
				if (!website) {
					new Notice("❌ Export Cancelled", 5000);
					return;
				}

				// Handle post-export operations for chunked export (identical to original)
				if (deleteOld)
				{
					let i = 0;
					ExportLog.addToProgressCap(website.index.deletedFiles.length / 2);
					for (const dFile of website.index.deletedFiles)
					{
						const path = new Path(dFile, destination.path);
						
						// don't delete font files
						if (path.extension == "woff" || path.extension == "woff2" || path.extension == "ttf" || path.extension == "otf")
						{
							ExportLog.progress(0.5, "Deleting Old Files", "Skipping: " + path.path, "var(--color-yellow)");
							continue;
						}

						await path.delete();
						ExportLog.progress(0.5, "Deleting Old Files", "Deleting: " + path.path, "var(--color-red)");
						i++;
					};

					await Path.removeEmptyDirectories(destination.path);
				}
				
				if (saveFiles) 
				{
					if (Settings.exportOptions.combineAsSingleFile)
					{
						await website.saveAsCombinedHTML();
					}
					else
					{
						await Utils.downloadAttachments(website.index.newFiles.filter((f) => !(f instanceof Webpage)));
						await Utils.downloadAttachments(website.index.updatedFiles.filter((f) => !(f instanceof Webpage)));

						if (Settings.exportPreset != ExportPreset.RawDocuments)
						{
							await Utils.downloadAttachments([website.index.websiteDataAttachment()]);
							await Utils.downloadAttachments([website.index.indexDataAttachment()]);
						}
					}
				}
			}
			catch (e)
			{
				new Notice("❌ Export Failed: " + e, 5000);
				ExportLog.error(e, "Export Failed", true);
			}

			// End batch processing exactly like the original exporter
			MarkdownRendererAPI.endBatch();
			
			return website;
		}

		// Regular export for smaller vaults
		MarkdownRendererAPI.beginBatch();
		let website = undefined;
		try
		{
			website = await (await new Website(destination).load(files)).build();

			if (!website)
			{
				new Notice("❌ Export Cancelled", 5000);
				return;
			}

			if (deleteOld)
			{
				let i = 0;
				ExportLog.addToProgressCap(website.index.deletedFiles.length / 2);
				for (const dFile of website.index.deletedFiles)
				{
					const path = new Path(dFile, destination.path);
					
					// don't delete font files
					// this is a hacky way to prevent it from deleting the matjax and other font files used in only certain files
					if (path.extension == "woff" || path.extension == "woff2" || path.extension == "ttf" || path.extension == "otf")
					{
						ExportLog.progress(0.5, "Deleting Old Files", "Skipping: " + path.path, "var(--color-yellow)");
						continue;
					}

					await path.delete();
					ExportLog.progress(0.5, "Deleting Old Files", "Deleting: " + path.path, "var(--color-red)");
					i++;
				};

				await Path.removeEmptyDirectories(destination.path);
			}
			
			if (saveFiles) 
			{
				if (Settings.exportOptions.combineAsSingleFile)
				{
					await website.saveAsCombinedHTML();
				}
				else
				{
					await Utils.downloadAttachments(website.index.newFiles.filter((f) => !(f instanceof Webpage)));
					await Utils.downloadAttachments(website.index.updatedFiles.filter((f) => !(f instanceof Webpage)));

					if (Settings.exportPreset != ExportPreset.RawDocuments)
					{
						await Utils.downloadAttachments([website.index.websiteDataAttachment()]);
						await Utils.downloadAttachments([website.index.indexDataAttachment()]);
					}
				}
			}
		}
		catch (e)
		{
			new Notice("❌ Export Failed: " + e, 5000);
			ExportLog.error(e, "Export Failed", true);
		}

		MarkdownRendererAPI.endBatch();

		return website;
	}

	public static async exportFolder(folder: TFolder, rootExportPath: Path, saveFiles: boolean, clearDirectory: boolean) : Promise<Website | undefined>
	{
		const folderPath = new Path(folder.path);
		const allFiles = app.vault.getFiles();
		const files = allFiles.filter((file) => new Path(file.path).directory.path.startsWith(folderPath.path));

		return await this.exportFiles(files, rootExportPath, saveFiles, clearDirectory);
	}

	public static async exportVault(rootExportPath: Path, saveFiles: boolean, clearDirectory: boolean) : Promise<Website | undefined>
	{
		const files = app.vault.getFiles();
		return await this.exportFiles(files, rootExportPath, saveFiles, clearDirectory);
	}

}
