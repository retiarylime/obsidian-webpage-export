console.log('Starting export script...');

const chokidar = require('chokidar');

(async () => {
	try {
		console.log('Enabling plugins...');
		await this.app.plugins.setEnable(true);

		console.log('Enabling export plugin...');
		await this.app.plugins.enablePlugin('webpage-html-export');
		const plugin = await this.app.plugins.getPlugin('webpage-html-export');

		const exportFunction = async () => {
			try {
				if (process.env.EXPORT_ENTIRE_VAULT) {
					console.log('Exporting entire vault...');
					await plugin.exportVault('/output');
				} else {
					console.log('Exporting...');
					await plugin.exportDocker();
				}
				console.log('Exported');
			} catch (error) {
				console.error('Export failed:', error);
			}
		};

		// Initial export
		await exportFunction();

		// Watch for changes
		console.log('Watching for file changes in /vault...');
		const watcher = chokidar.watch('/vault', {
			ignored: /(^|[\/\\])\../, // ignore dotfiles
			persistent: true
		});

		watcher.on('change', (path) => {
			console.log(`File ${path} has been changed, re-exporting...`);
			exportFunction();
		});

		watcher.on('add', (path) => {
			console.log(`File ${path} has been added, re-exporting...`);
			exportFunction();
		});

		watcher.on('unlink', (path) => {
			console.log(`File ${path} has been removed, re-exporting...`);
			exportFunction();
		});

		// Keep the process running
		console.log('Watching for changes...');

	} catch (error) {
		console.error('Error:', error);
		// Don't kill, let it keep running
	}
})();