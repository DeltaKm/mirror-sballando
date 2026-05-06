const video = document.getElementById('video');
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const cameraSelect = document.getElementById('cameraSelect');
const captureBtn = document.getElementById('captureBtn');
const fullscreenBtn = document.getElementById('fullscreenBtn');
const exitFullscreenBtn = document.getElementById('exitFullscreenBtn');
const videoContainer = document.getElementById('videoContainer');
const frameOverlay = document.getElementById('frameOverlay1');

var TOGGLE_CORNICI_INDEX = 1;

let currentStream;
let videoTracks;
let devices = [];
let currentDeviceId;
const stretchFactor = 1; // Fattore di allungamento laterale (20%)

var url_ = new URL(window.location.href);
var EVENT_ID = url_.searchParams.get('id');
var EVENT_ID = 4;
var EVENT_TITLE = null;

FETCH(
    'https://webservice.sballando.it/api/event/show',
    EVENT_ID,
    function(content){
        console.log(content);
        var event = content.event;
        EVENT_TITLE = event.title;
    }
);

function FETCH(url,event_id,callback_success,callback_fail) {
    if(!callback_success) callback_success = function(){};
    if(!callback_fail) callback_fail = function(){};
    fetch(url, {method: 'POST',headers: {'Content-Type': 'application/json'},body: JSON.stringify({event_id: event_id})}).then(response => response.json()).then(data => {callback_success(data);}).catch(error => {callback_fail(error);});
}

async function getCameraStream(deviceId) {
    if (currentStream) {
        currentStream.getTracks().forEach(track => track.stop());
    }

    let constraints = {
        video: {
            deviceId: deviceId ? { exact: deviceId } : undefined,
            width: { ideal: 1200 },
            height: { ideal: 1920 },
            facingMode: deviceId ? undefined : 'environment'
        }
    };

    try {
        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        video.srcObject = stream;
        currentStream = stream;
        videoTracks = stream.getVideoTracks();
        currentDeviceId = videoTracks[0].getSettings().deviceId;
        const settings = videoTracks[0].getSettings();
        console.log(`Risoluzione video: ${settings.width}x${settings.height}`);
    } catch (err) {
        console.error('Errore con vincoli di risoluzione:', err);
        constraints.video = {
            deviceId: deviceId ? { exact: deviceId } : undefined,
            facingMode: deviceId ? undefined : 'environment'
        };
        try {
            const stream = await navigator.mediaDevices.getUserMedia(constraints);
            video.srcObject = stream;
            currentStream = stream;
            videoTracks = stream.getVideoTracks();
            currentDeviceId = videoTracks[0].getSettings().deviceId;
            const settings = videoTracks[0].getSettings();
            console.log(`Risoluzione video fallback: ${settings.width}x${settings.height}`);
        } catch (fallbackErr) {
            console.error('Errore anche con fallback:', fallbackErr);
            alert(`Impossibile accedere alla camera: ${fallbackErr.name} - ${fallbackErr.message}. Verifica i permessi.`);
        }
    }
}

async function listCameras() {
    try {
        devices = await navigator.mediaDevices.enumerateDevices();
        devices = devices.filter(device => device.kind === 'videoinput');

        cameraSelect.innerHTML = '';
        devices.forEach((device, index) => {
            const option = document.createElement('option');
            option.value = device.deviceId;
            option.text = device.label || `Camera ${index + 1}`;
            cameraSelect.appendChild(option);
        });

        if (devices.length > 0) {
            cameraSelect.value = currentDeviceId || devices[0].deviceId;
        }
    } catch (err) {
        console.error('Errore nell\'elencare i dispositivi:', err);
    }
}

cameraSelect.addEventListener('change', (e) => {
    getCameraStream(e.target.value);
});

captureBtn.addEventListener('click', () => {
    if (!video.videoWidth || !video.videoHeight) {
        alert('Il video non è pronto. Riprova.');
        return;
    }

    const videoWidth = video.videoWidth * stretchFactor;
    const videoHeight = video.videoHeight;
    let sx = 0, sy = 0, sWidth = video.videoWidth, sHeight = videoHeight;

    const targetWidth = 1200;
    const targetHeight = 1920;
    const targetAspectRatio = targetWidth / targetHeight;
    const videoAspectRatio = videoWidth / videoHeight;

    if (videoAspectRatio > targetAspectRatio) {
        sHeight = videoHeight;
        sWidth = videoHeight * targetAspectRatio / stretchFactor;
        sx = (video.videoWidth - sWidth) / 2;
        sy = 0;
    } else {
        sWidth = video.videoWidth;
        sHeight = video.videoWidth / targetAspectRatio * stretchFactor;
        sx = 0;
        sy = (videoHeight - sHeight) / 2;
    }

    ctx.drawImage(video, sx, sy, sWidth, sHeight, 0, 0, targetWidth, targetHeight);

    const frameImage = new Image();

    frameImage.src = "sballando_cornice_"+TOGGLE_CORNICI_INDEX+".png";
    frameImage.onload = () => {
        ctx.drawImage(frameImage, 0, 0, targetWidth, targetHeight);

        canvas.toBlob((blob) => {
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.style.display = 'none';
            a.href = url;
            var foto_name = EVENT_TITLE.replaceAll(" ","_")+"§"+(new Date().toISOString().slice(0, 19).replace(/:/g, '-'))+".jpg";
            a.download = foto_name;
            localStorage.setItem("last_picture_name",foto_name);
            localStorage.setItem("last_picture_url",url);
            foto_temp_show();
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
        }, 'image/jpeg', 1.0);
    };
    frameImage.onerror = () => {
        alert('Errore nel caricamento della cornice. Verifica che "sballando_cornice_1.png" sia nella directory corretta.');
    };
});

fullscreenBtn.addEventListener('click', () => {
    if (videoContainer.requestFullscreen) {
        videoContainer.requestFullscreen();
    } else if (videoContainer.mozRequestFullScreen) {
        videoContainer.mozRequestFullScreen();
    } else if (videoContainer.webkitRequestFullscreen) {
        videoContainer.webkitRequestFullscreen();
    } else if (videoContainer.msRequestFullscreen) {
        videoContainer.msRequestFullscreen();
    }
});

exitFullscreenBtn.addEventListener('click', () => {
    if (document.exitFullscreen) {
        document.exitFullscreen();
    } else if (document.mozCancelFullScreen) { // Firefox
        document.mozCancelFullScreen();
    } else if (document.webkitExitFullscreen) { // Chrome, Safari, Edge (vecchie versioni)
        document.webkitExitFullscreen();
    } else if (document.msExitFullscreen) { // Internet Explorer
        document.msExitFullscreen();
    }
});

async function init() {
    await getCameraStream();
    await listCameras();
}

var TOTEM_ESCAPE_MODAL_INDEX = 0;
function TOTEM_ESCAPE_MODAL() {
    document.querySelector("#controls").style.display = "block";
}

function foto_temp_show() {
    document.querySelector("#foto_temp > img").src = localStorage.getItem("last_picture_url");
    document.querySelector("#foto_temp").style.display = "block";
}

function TOTEM_ESCAPE_MODAL_EXIT() {
    TOTEM_ESCAPE_MODAL_INDEX = 0;
    document.querySelector("#controls").style.display = "none";
}

init();

navigator.mediaDevices.addEventListener('devicechange', listCameras);

setTimeout(
    function() {
        fullscreenBtn.click();
    },
    1000
);

function toggle_cornici(mode) {

    document.querySelector("#frameOverlay1").style.display = "none";
    document.querySelector("#frameOverlay2").style.display = "none";
    document.querySelector("#frameOverlay3").style.display = "none";
    document.querySelector("#frameOverlay4").style.display = "none";
    document.querySelector("#frameOverlay5").style.display = "none";

    if(mode == 'right') TOGGLE_CORNICI_INDEX++;
    if(mode == 'left') TOGGLE_CORNICI_INDEX--;

    
    if(TOGGLE_CORNICI_INDEX > 5) {
        TOGGLE_CORNICI_INDEX = 1;
    }
    if(TOGGLE_CORNICI_INDEX < 1) {
        TOGGLE_CORNICI_INDEX = 5;
    }

    document.querySelector("#frameOverlay"+TOGGLE_CORNICI_INDEX).style.display = "block";

}
var COUNT_DOWN_START_INDEX = 0;

function count_down_start(mode) {
    if(mode) {
        COUNT_DOWN_START_INDEX = mode;
        document.querySelector("#count_down").innerHTML = COUNT_DOWN_START_INDEX;
        document.querySelector("#count_down").style.display = "block";
        document.querySelector("#controls_user").style.display = "none";
        COUNT_DOWN_START_INDEX--;
    }
    setTimeout(
        function() {
            document.querySelector("#count_down").innerHTML = COUNT_DOWN_START_INDEX;
            document.querySelector("#count_down").style.display = "block";
            COUNT_DOWN_START_INDEX--;
            if(COUNT_DOWN_START_INDEX >= 0) {
                count_down_start();
            }else{
                document.querySelector("#count_down").style.display = "none";
                document.querySelector("#controls_user").style.display = "block";
                document.querySelector('#captureBtn').click();
            }
        },
        1000
    );
}

function controls_user_temp_cancel() {
    var filename = localStorage.getItem("last_picture_name");
    try {
        window.electronAPI.deletePhoto(filename);
    } catch (error) {
        alert('Errore nella comunicazione con Electron: ' + error.message);
    }
    document.querySelector("#foto_temp").style.display = "none";
}

function controls_user_temp_ok() {
    var filename_ = localStorage.getItem("last_picture_name");
    document.querySelector("#foto_temp_loading").style.display = "block";
    window.electronAPI.uploadPhoto(filename_).then(response => {
        console.log(response);
        document.querySelector("#foto_temp").style.display = "none";
        document.querySelector("#foto_temp_loading").style.display = "none";
    });
}

var TOGGLE_FULL_SCREEN_INDEX = 0;

function toggle_full_screen() {
    if(TOGGLE_FULL_SCREEN_INDEX == 1) {
        fullscreenBtn.click();
        TOGGLE_FULL_SCREEN_INDEX = 0;
    }else{
        exitFullscreenBtn.click();
        TOGGLE_FULL_SCREEN_INDEX = 1;
     }
}