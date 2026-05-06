const { app, BrowserWindow, session, ipcMain } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs').promises;
const Client = require('ssh2-sftp-client');

function createWindow() {
    const win = new BrowserWindow({
        //fullscreen: true,
        icon: path.join(__dirname, 'favicon.ico'),
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js')
        }
    });

    var ver_cache = Date.now();
    win.loadURL('https://webservice.sballando.it/mirror/index.php');
    //win.loadURL('https://webservice.sballando.it/mirror/index6.html?id=24&ver='+ver_cache);
    //win.loadFile('index.html');
    win.setMenu(null);

    session.defaultSession.on('will-download', (event, item, webContents) => {

        var fileName_full = item.getFilename();
        var folder = fileName_full.split("§")[0];
        var fileName = fileName_full.split("§")[1];

        //const downloadPath = path.join(__dirname, 'Foto/'+folder);

        const appPath = app.isPackaged ? path.dirname(app.getPath('exe')) : __dirname;

        const downloadPath = path.join(appPath, 'Foto/'+folder);

        item.setSavePath(path.join(downloadPath, fileName));

        const fs = require('fs');
        if (!fs.existsSync(downloadPath)) {
            fs.mkdirSync(downloadPath, { recursive: true });
        }

        item.on('updated', (event, state) => {
            if (state === 'interrupted') {
                console.log('Download interrotto');
            } else if (state === 'progressing') {
                if (item.isPaused()) {
                    console.log('Download in pausa');
                } else {
                    console.log(`Download in corso: ${item.getReceivedBytes()} di ${item.getTotalBytes()}`);
                }
            }
        });

        item.on('done', (event, state) => {
            if (state === 'completed') {
                console.log(`Foto salvata in: ${item.getSavePath()}`);

                //const destinationPath = path.join(__dirname, 'print.jpg');
                //alert(destinationPath);
                const destinationPath = 'C:/Users/Utente/Documents/print.jpg';
                fs.copyFile(downloadPath+"/"+fileName, destinationPath, (err) => {
                  if (err) {
                    console.error('Errore durante la copia del file:', err);
                    return;
                  }
                  console.log('File copiato con successo!');
                });

            } else {
                console.error(`Download fallito: ${state}`);
            }
        });
    });
}

function printImage_2(imagePath, printerName) {
    const fs = require('fs');
    const path = require('path');
    //const filePath = path.join(__dirname, 'print.txt');
    const filePath = 'C:/Users/Utente/Documents/print.txt';
    
    //var contenuto = "ax"+Date.now();
    var contenuto = " ";

    fs.writeFile(filePath, contenuto, (err) => {
        if (err) {
          console.error('Errore durante la scrittura del file:', err);
          return;
        }
        console.log('File scritto con successo!');
      });
}

function printImage(imagePath, printerName) {
  // Crea una finestra off-screen per caricare l'immagine
  console.log(imagePath);
  console.log(printerName);
  const printWindow = new BrowserWindow({
    width: 800,
    height: 600,
    show: false, // Invisibile
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  });

  const imageUrl = `file://${path.resolve(imagePath).replace(/\\/g, '/')}`;
//margin-bottom: -.5cm;
//height: 15cm;
  const htmlContent = `<html>
    <head>
        <style>
            @page {
                margin-top: 0.5cm;
                margin-left: 0.1cm;
                margin-right: 0cm;
                margin-bottom: 0cm;
                height: 15cm;
                width: 10cm;
            }
            body { 
                margin: 0cm 0cm 0cm 0cm; 
                height: 15cm; 
                width: 10cm;
            }
            img { 
                margin: 0cm 0cm 0cm 0cm; 
                height: 15cm; 
                width: 10cm;
            }
        </style>
    </head>
    <body>
        <img src="${imageUrl}" />
    </body>
</html>`;
  console.log(htmlContent);
  const appPath = app.isPackaged ? path.dirname(app.getPath('exe')) : __dirname;
  const tempFile = path.join(appPath, 'temp.html');
  const fs = require('fs');
  fs.writeFileSync(tempFile, htmlContent);
  printWindow.loadFile(tempFile);

  // const dataUrl = `data:text/html;charset=UTF-8,${encodeURIComponent(htmlContent)}`;
  // console.log(dataUrl);
  // printWindow.loadURL(dataUrl);

  printWindow.webContents.on('did-finish-load', () => {
  printWindow.webContents.print(
      {
        silent: true, // Senza dialogo
        deviceName: printerName, // Nome esatto della stampante
        printBackground: true, // Stampa sfondi se presenti
        color: true, // Stampa a colori
        margin: { marginType: 'printableArea' } // Senza margini
      },
      (success, errorType) => {
        if (!success) {
          console.error('Errore stampa:', errorType);
        }
        printWindow.close(); // Chiudi la finestra
      }
    );
  });
}
let printWindow;
ipcMain.handle('get-printers', async () => {
    //const printers = await window.electronAPI.getPrinters();
    const printers = printWindow.webContents.getPrinters();
    return printers;
  });

ipcMain.handle('print-image', async (event, filename, printerName) => {
    console.log('print-image 1');
    const appPath = app.isPackaged ? path.dirname(app.getPath('exe')) : __dirname;
    console.log('print-image 2');
    const downloadPath = path.join(appPath, 'Foto/');
    //printImage(downloadPath+filename, printerName);
    printImage_2();
});

ipcMain.handle('delete-photo', async (event, filename_) => {
    console.log(`delete-photo: ${filename_}`);
    const folder = filename_.split("§")[0];
    const filename = filename_.split("§")[1];

    const appPath = app.isPackaged ? path.dirname(app.getPath('exe')) : __dirname;
    const downloadPath = path.join(appPath, 'Foto/'+folder);

    try {
        const filePath = path.join(downloadPath, filename);
        await fs.unlink(filePath);
        console.log(`Foto cancellata: ${filePath}`);
        return { success: true, message: `Foto ${filename} cancellata con successo` };
    } catch (error) {
        console.error(`Errore durante la cancellazione di ${filename}:`, error);
        event.reply('delete-photo-response', { success: false, message: `Errore: ${error.message}` });
    }
});

ipcMain.handle('upload-photo', async (event, filename_) => {
  console.log(`upload-photo: ${filename_}`);

  const folder = filename_.split("§")[0];
  const filename = filename_.split("§")[1];

  const appPath = app.isPackaged ? path.dirname(app.getPath('exe')) : __dirname;
  const downloadPath = path.join(appPath, 'Foto/'+folder);

  try {
    const filePath = path.join(downloadPath, filename);
    // Verifica che il file esista
    await fs.access(filePath);

    const sftp = new Client();
    const config = {
      host: '217.160.144.254',
      port: 22,
      username: 'root',
      password: 'Sh4d0vv@ZOII!'
      // privateKey: fs.readFileSync('/percorso/alla/tua/chiave'),
      // passphrase: 'tua_passphrase'
    };

    await sftp.connect(config);
    const remotePath = `/var/www/html/webservice.sballando.it/storage/app/public/images/events/${folder}/gallery/${filename}`;
    await sftp.put(filePath, remotePath);
    await sftp.end();

    return { success: true, message: `Foto ${filename} caricata con successo su ${remotePath}` };
  } catch (error) {
    console.error(`Errore durante l'upload di ${filename}:`, error);
    return { success: false, message: `Errore: ${error.message}` };
  }
});

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
    }
});