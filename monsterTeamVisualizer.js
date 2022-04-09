/**
 * This widget attempts to make the visualization of monster-teams easier, reusable and also manageable by (specific)
 * chat participants.
 * 
 * To achieve this, it uses external URLs to monster images that are organized as JSON structures and are stored
 * in a pastebin.com document. The displayed image can be changed by privileged users via chat commands.
 * 
 * Command types:
 * !slot1 tag [key1, key2, ... keyN]             (Follows the structure of the particular pastebin.com entry.)
 * !slot1 ko
 * !slot1 ok
 * !slot1 clear
 * 
 * I would like to thank the users Reboot0, thefyrewire, pjonp and lx of the StreamElements discord server for 
 * pointing out concepts and answering my questions.
 */


let userOptions = {};
let triggerPhrase = "";                         // The specified command with an appended space (e.g. "!slot1 ").
let dbKey = "";                                 // Key which is used to store values persistently via SE_API.
let monsterData = {monsterURL: "",
                   incapacitated: false};       // Object that is persistently stored.
let isDisplayingMonster = false;
let coolDownMillis = 5000;
let lastSuccessEpoch = 0;                       // Logs the timestamp of the last successful execution.
let monsterTransitionMillis = 800;              // Time it takes to fade out the monster image.
let fyreURL_base = "";                          // Base link for Fyre API (https://thefyrewire.com/docs/api/twitch/pastebin/).
let isPastebinProvided = false;
let backgroundElement, monsterElement;
let isInitialisationCompleted = false;


window.addEventListener('onWidgetLoad', async function (obj) {
    userOptions = obj['detail']['fieldData'];
    
    userOptions['channelName'] = obj['detail']['channel']['username'];
    userOptions['additionalUsers'] = userOptions['additionalUsers'].toLowerCase().replace(/\s/g, '').split(",");
    userOptions['command1'] = userOptions['command1'].toLowerCase();
    
    // Since only the beginning of a chat message is evaluated in order to decide whether the widget gets triggered or not,
    // a space is appended to prevent false positive matches (e.g. "!slot1" would also trigger "!slot11").
    triggerPhrase = userOptions['command1'] + " ";
    
    // In case that the widget gets duplicated, the command text is part of the database key. That way, each individually 
    // addressable widget has its own persistent values. (Also used to identify a widget in debugging output.)
    dbKey = "monsterteamv2_" + userOptions['command1'].replace(/[^A-Za-z0-9_]/g, '');     // removes non-alphanumeric chars.
    
    coolDownMillis = userOptions['cooldown'] * 1000;
    monsterTransitionMillis = userOptions['monster_transition_duration'] * 500;           // transition consists of 2 halfes.
    
    // The name-resolution-mechanism is realized via thefyrewire pastebin API.
    let pastebinID = /[^/]*$/.exec(userOptions['pastebin_url'])[0];     // get substring after the last '/'.
    if (pastebinID) {
        fyreURL_base = "https://api.thefyrewire.com/twitch/pastebin/" + pastebinID + "?filter=";
        console.log(dbKey + " uses Fyre API base link: " + fyreURL_base);
        
        isPastebinProvided = true;
    }
    
    backgroundElement = document.getElementById('background');
    monsterElement = document.getElementById('monster');
    
    // If a background img was provided, put it in place.
    let backgroundURL = userOptions['background_img'];
    if (backgroundURL) {
        appendImgToElement(backgroundElement, 
                           backgroundURL, 
                           userOptions['background_img_scale'], 
                           (userOptions['background_img_opacity'] / 100));
    }
    
    // Restore state via SE_API.
    if (userOptions['test_mode_activation'] === 'off') {
        try {
            let obj = await SE_API.store.get(dbKey);
            if (obj) {
                let monsterURL = obj['monsterURL'];
                if (monsterURL) {
                    appendMonsterImg(monsterURL);
                    
                    console.log(dbKey + " restored monsterURL: " + monsterData['monsterURL']);
                }
                
                if (obj['incapacitated']) {
                    applyKOFilters();
                    
                    console.log(dbKey + " restored as incapacitated.");
                }
            }
        } catch(error) {
            log(dbKey + " had an exception while restoring state.", 
                "warning"); 
            log(error.stack,
                "error");
        }
        
    // Test mode doesn't set persistent values. That means, when it is deactivated, the previous values will be restored.
    } else {
        let commandArgs = splitCommandArgs(userOptions['test_args'].toLowerCase());
        commandArgs.unshift(userOptions['command1']);           // Compensates the missing command part ("!slot1 ...").
        
        // Less than 2 args means a syntactical error (minimum requirement: "!command1 arg1").
        if (isPastebinProvided && (commandArgs.length > 1)) {
            console.log(dbKey + " simulated command arguments: " + commandArgs);
            
            try { 
                let url = await receiveMonsterURL(commandArgs);          // Name-resolution-mechanism
                
                console.log(dbKey + " received test monsterURL: " + url);
                
                if (url) {
                    appendMonsterImg(url);
                    
                    console.log(dbKey + " uses received monsterURL.");
                }
            } catch(error) {
                log(dbKey + " had an exception while resolving simulated arguments.", 
                    "warning"); 
                log(error.stack, 
                    "error");
            }
            
            if (userOptions['test_incapacitated'] === "on") {
                applyKOFilters();
                
                console.log(dbKey + " simulated as incapacitated.");
            }
        }
    }
    
    isInitialisationCompleted = true;
});


window.addEventListener('onEventReceived', async function (obj) {
    // Ignore any event that isn't a chat message.
    if (obj.detail.listener !== 'message') return;
    
    let data = obj.detail.event.data;
    
    // To prevent unnecessary processing, only the beginning of the message is converted to lowercase and tested.
    let message = data['text'].substring(0, triggerPhrase.length).toLowerCase();
    if (message !== triggerPhrase) return;
    
    console.log(dbKey + " recognized '" + message + "'");
    
    if (!isInitialisationCompleted || isOnCoolDown()) return;
    
    let user = data['nick'].toLowerCase();
    
    // Preparing userState object containing all user flags
    let userState = {
        'mod': parseInt(data.tags.mod),
        'sub': parseInt(data.tags.subscriber),
        'vip': (data.tags.badges.indexOf("vip") !== -1),
        'broadcaster': (user === userOptions['channelName'])
    };
    
    // Check if user has the correct permission level to trigger the command.
    if ((userOptions['permissionLvl'] === 'everyone') || 
        (userState.mod && userOptions['permissionLvl'] === 'mods') || 
        ((userState.vip || userState.mod) && (userOptions['permissionLvl'] === 'vips')) || 
        userState.broadcaster || 
        (userOptions['additionalUsers'].indexOf(user) !== -1)) {
        
        // Now that it is established that the chat message begins with the trigger phrase and that the user is allowed to
        // use the command, the whole message can be processed.
        let commandArgs = splitCommandArgs(data['text'].toLowerCase());
        
        // Less than 2 args means a syntactical error (minimum requirement: "!command1 arg1").
        if (commandArgs.length < 2) return;
        
        console.log(dbKey + " uses command arguments: " + commandArgs);
        
        let hasStateChanged = false;
        
        if (commandArgs[1] === "clear") {
            await removeMonsterImg();
            
            hasStateChanged = true;
            
        } else if (commandArgs[1] === "ko") {
            // This is not part of the superordinated if-clause to filter out the trigger word (otherwise it would be interpreted 
            // as tag).
            if (!monsterData['incapacitated']) {
                applyKOFilters();
                
                hasStateChanged = true;
            }
        } else if (commandArgs[1] === "ok") {
            // Same explanation as "ko".
            if (monsterData['incapacitated']) {
                undoKOFilters();
                
                hasStateChanged = true;
            }
        } else if (isPastebinProvided) {
            try{
                let url = await receiveMonsterURL(commandArgs);         // Name-resolution-mechanism 
                
                console.log(dbKey + " received monsterURL: " + url);
                
                if (url) {
                    assignImgForPreload(url, "preloaded_img");
                    
                    await removeMonsterImg();
                    
                    appendMonsterImg(url);
                    
                    console.log(dbKey + " uses received monsterURL.");
                    
                    hasStateChanged = true;
                }
            } catch(error) {
                log(dbKey + " had an exception while resolving command arguments.", 
                    "warning"); 
                log(error.stack, 
                    "error");
                
            } finally {
                removeDOMElement("preloaded_img");
            }
        }
        
        if (hasStateChanged) {
            SE_API.store.set(dbKey, monsterData);
        }
        
        lastSuccessEpoch = Date.now();          // Sets the cool down.
    }
});


// According to the mozilla documentation: "The 'preload' value of the link element's rel attribute lets you specify resources 
// that your page will need very soon". No clue whether this applies to widgets or not. 
function assignImgForPreload(url, id) {
    let preImg = document.createElement('link');
    preImg.href = url;
    preImg.rel = 'preload';
    preImg.as = 'image';
    preImg.id = id;
    
    document.head.appendChild(preImg);
}


function removeDOMElement(id) {
    let element = document.getElementById(id);
    
    if (element) element.remove();
}


// Creates an img tag and appends it to a parent element.
function appendImgToElement(parent, imgURL, scalePercentage, opacity = 1) {
    let img = document.createElement('img');
    
    img.setAttribute('width', scalePercentage + "%");
    
    // When the src is successfully loaded, fade it in.
    img.onload = function() {
        parent.appendChild(this);
        parent.style.opacity = opacity;
    };
    
    img.onerror = function() {
        log(dbKey + " could not load image '" + imgURL + "'",
            "error");
    };
    
    img.setAttribute('src', imgURL);            // Has to be placed after onload() or onerror().
}


// Convenience function that reduces parameters of appendImgToElement().
function appendMonsterImg(imgURL) {
    appendImgToElement(monsterElement, 
                       imgURL, 
                       userOptions['monster_scale']);
    
    monsterData['monsterURL'] = imgURL;
    isDisplayingMonster = true;
}


function sleep(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}


// Fades out the current monster image and removes it, when it's not visible.
async function removeMonsterImg() {
    if(isDisplayingMonster) {
        monsterElement.style.opacity = 0;
        
        // Pauses for the amount of time it takes for the image to fade out.
        await sleep(monsterTransitionMillis);
    }
    
    // Not inside the clause to ensure deletion under any circumstances.
    monsterElement.innerHTML = "";          // Delete current img elements.
    monsterData['monsterURL'] = "";
    isDisplayingMonster = false;
    
    if (monsterData['incapacitated']) {
        undoKOFilters();
    }
}


// Processes a command string, in order to extract the individual command parts and returns them as an array.  
function splitCommandArgs(commandString) {
    if (!commandString) return [];
    
    let result;
    
    // One or more whitespaces are replaced with a single space (get rid of multiple spaces etc.)
    result = commandString.replace(/\s+/g, ' ');
    
    // Splits the string at the spaces, but ignores those that appear within quotation marks.
    result = result.match(/(?:[^\s"']+|['"][^'"]*["'])+/g);
    
    // If there were matches, get rid of quotation marks that may occur. Otherwise return an empty array.
    result = result ? result.map(x => x.replace(/["']/g,"")) : [];
    
    return result;
}


// Converts all keys to lowercase before testing for equality.
function lowerCaseObjectSearch(obj, key) {
    let result;
    
    $.each(obj, function(k, v) {
        if (k.toLowerCase() === key) {          // 'key' is already lowercase.
            result = v;
            return false;           // breaks the loop.
        }
    });
    
    return result;
}


// Uses command arguments to query the pastebin document and to figure out which result to return.
async function receiveMonsterURL(commandArgs) {
    // Queries the pastebin document via thefyrewire API. The result is a stringified JSON object or an empty string.
    let fyreURL = fyreURL_base + encodeURIComponent(commandArgs[1]);
    let pastebinEntry = await $.get({url: fyreURL, 
                                     dataType: "text"});
    
    if (!pastebinEntry) return;
    
    // Incorrect JSON syntax will trigger an exception.
    let monsterJSON = JSON.parse(pastebinEntry);
    
    // Ignores the first two elements, since they aren't needed anymore (e.g. "!command1 arg1").
    return searchRelay(monsterJSON, 2);
    
    // Recursive, level-wise search. In each level it searches for one key (in the same order as in the array).
    function searchRelay(obj, argIndex) {
        if (typeof(obj) === "object") {
            if (argIndex < commandArgs.length) {
                // If the element is a object, search for the current key.
                return searchRelay(lowerCaseObjectSearch(obj, commandArgs[argIndex]), 
                                   argIndex + 1);
            } else {
                // Allows a shorthand notation if a default value was specified in the pastebin entry (the last key can be 
                // omitted).
                return lowerCaseObjectSearch(obj, "default");
            }
        } else {
            // If a result is found, return it (even if there are command arguments left).
            return obj;
        }
    }
}


// Changes the colors of the images to illustrate the incapacitated state.
function applyKOFilters() {
    backgroundElement.style.filter = ('grayscale(' + userOptions['background_img_incapacitated_greyscale'] + '%) ' 
                                    + 'brightness(' + userOptions['background_img_incapacitated_brightness'] + '%)');
    monsterElement.style.filter = ('grayscale(' + userOptions['monster_incapacitated_greyscale'] + '%) ' 
                                 + 'brightness(' + userOptions['monster_incapacitated_brightness'] + '%)');
    
    monsterData['incapacitated'] = true;
}


// Changes the colors of the images back to the original.
function undoKOFilters() {
    backgroundElement.style.filter = 'none';
    monsterElement.style.filter = 'none';
    
    monsterData['incapacitated'] = false;
}


// The command isn't executed as long as this returns true.
function isOnCoolDown() {
    if (coolDownMillis === 0) return false;
    
    let elapsedMillis = Date.now() - lastSuccessEpoch;
    
    if (elapsedMillis > coolDownMillis) {
        return false;
    } else {
        log(dbKey + " is still on cooldown (" + elapsedMillis + " / " + coolDownMillis + " ms)",
            "warning");
        
        return true;
    }
}


// Convenience function that colorizes the output of console.log().
function log(msg, type) {
    let style = "";
    
    switch(type) {
        case "warning": 
            style = "color: orange"; 
            break;
        case "error": 
            style = "color: red";
            break;
        default:
            break;
    }
    
    console.log("%c" + msg,
                style);
}
