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
		// DEBUG: Always log export decision
		ExportLog.log(`🔍 EXPORT DECISION: ${files.length} files detected`);
		const shouldUseChunked = ChunkedWebsiteExporter.shouldUseChunkedExport(files);
		ExportLog.log(`🔍 EXPORT DECISION: shouldUseChunkedExport = ${shouldUseChunked} (threshold: >200 files)`);
		
		// Check if we should use chunked export for large file sets
		if (shouldUseChunked)
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
						// Debug: Check MP3 files before download
						const newAttachments = website.index.newFiles.filter((f) => !(f instanceof Webpage));
						const updatedAttachments = website.index.updatedFiles.filter((f) => !(f instanceof Webpage));
						
						const allMP3s = website.index.newFiles.concat(website.index.updatedFiles).filter(f => f.sourcePath?.endsWith(".mp3"));
						console.log(`🎵 DEBUG: Found ${allMP3s.length} MP3 files total:`);
						allMP3s.forEach(mp3 => {
							console.log(`  - ${mp3.sourcePath} -> ${mp3.targetPath.path} (${mp3.constructor.name}, instanceof Webpage: ${mp3 instanceof Webpage})`);
						});
						
						const mp3Attachments = newAttachments.concat(updatedAttachments).filter(f => f.sourcePath?.endsWith(".mp3"));
						console.log(`🎵 DEBUG: ${mp3Attachments.length} MP3 files will be downloaded as attachments`);
						
						await Utils.downloadAttachments(newAttachments);
						await Utils.downloadAttachments(updatedAttachments);

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
		ExportLog.log(`📄 Small vault detected (${files.length} files) - using regular export`);
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

					// Debug: log MP3 download filtering for regular export
					const regularNewMP3s = website.index.newFiles.filter(f => f.sourcePath?.endsWith(".mp3"));
					const regularNewMP3Attachments = regularNewMP3s.filter(f => !(f instanceof Webpage));
					const regularNewMP3Webpages = regularNewMP3s.filter(f => f instanceof Webpage);
					if (regularNewMP3s.length > 0) {
						console.log(`🎵 REGULAR DOWNLOAD FILTER - MP3 files: ${regularNewMP3s.length} total, ${regularNewMP3Attachments.length} attachments to download, ${regularNewMP3Webpages.length} webpages filtered out`);
						regularNewMP3Attachments.forEach(f => console.log(`  ✅ Will download: ${f.sourcePath} -> ${f.targetPath.path}`));
						regularNewMP3Webpages.forEach(f => console.log(`  ❌ Filtered out: ${f.sourcePath} -> ${f.targetPath.path} (${f.constructor.name})`));
					}

					// Debug: log MP3 download filtering for chunked export
					const newMP3s = website.index.newFiles.filter(f => f.sourcePath?.endsWith(".mp3"));
					const newMP3Attachments = newMP3s.filter(f => !(f instanceof Webpage));
					const newMP3Webpages = newMP3s.filter(f => f instanceof Webpage);
					if (newMP3s.length > 0) {
						console.log(`🎵 CHUNKED DOWNLOAD FILTER - MP3 files: ${newMP3s.length} total, ${newMP3Attachments.length} attachments to download, ${newMP3Webpages.length} webpages filtered out`);
						newMP3Attachments.forEach(f => console.log(`  ✅ Will download: ${f.sourcePath} -> ${f.targetPath.path}`));
						newMP3Webpages.forEach(f => console.log(`  ❌ Filtered out: ${f.sourcePath} -> ${f.targetPath.path} (${f.constructor.name})`));
					}

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
