/**
 * This widget attempts to make the visualization of monster teams easier, 
 * reusable and manageable by (particular) chat users.
 * 
 * The basic idea is, that a pastebin.com document is queried via thefyrewire's 
 * API. If an entry is found, a JSON structure containing one or more img URLs 
 * is returned. Which URL is used depends on the provided command arguments.
 * 
 * Special thanks to thefyrewire, Reboot0, pjonp, lx, Zaytri, johnny8769 and 
 * SquidCharger.
 */


// Reserved keywords that may become localizable in future versions.
const keywords = {
  slotWildcard: "*", 
  clearFg: "clear", 
  incapacitateSlot: "ko", 
  reviveSlot: "ok", 
  mirrorFgX: "mirror", 
  mirrorFgY: "mirrorY", 
  undoChange: "undo", 
  saveState: "saveState", 
  loadState: "loadState", 
  reloadFgs: "reload"
};

/* Waits this number of milliseconds before saving a state change (in anticipation 
 * of additional changes downstream). */
const saveDelayMillis = 30000;

/* Manages which previous states to keep for restoration. (Naming convention 
 * follows the Memento pattern.) */
const caretaker = {
  undoSteps: 5, 
  undoStack: [],                    // Holds a maximum of 'undoSteps' mementos.
  
  hasPreceding() {
    return (this.undoStack.length > 0);
  }, 
  
  push(memento) {
    // Limits the number of reversible changes.
    if (this.undoStack.length >= this.undoSteps) {
      this.undoStack.shift();
    }
    
    this.undoStack.push(memento);
  }, 
  
  popPreceding() {
    return this.undoStack.pop();
  }
}

const storeKeys = {};               // Keys for the SE_API store.
const monsterSlots = [];            // Holds slot proxies.

let triggerPhrase;                  // Command text with appended whitespace.
let argsToUrlResolver;              // Queries with args and receives an URL.
let isUsableByMods;
let otherUsers;                     // Those users can trigger the widget, too.
let blockedUsers;                   // Those users are ignored by the widget.
let cooldownMillis;
let cooldownEndEpoch = 0;           // Epoch time for when a cooldown has ended.

let visualizeSaveState;             // Visual feedback of save state mechanism.

let timeoutId = null;               // Used by the delayed saving mechanism.
let isBlocked = true;               // Blocks the widget when busy.


/* This class handles the basic animation logic. Its behavior is refined into 
 * more sophisticated mechanisms in later classes.
 * I decided to use GSAP, because some animations may overlap, which is very 
 * tedious to implement in a controlled manner with CSS animations/transitions 
 * (not to mention the handling of interruptions etc). */
class ImgView {
  rootCont;
  filterCont;
  shadowCont;
  mirrorCont;
  imgCont;
  
  #img = null;
  
  constructor(rootCont, filterCont, shadowCont, mirrorCont, imgCont) {
    this.rootCont = rootCont;
    
    /* Containers can be specified independently, to allow for potential nesting 
     * in the root container. */
    this.filterCont = filterCont ?? this.rootCont;
    this.shadowCont = shadowCont ?? this.filterCont;
    this.mirrorCont = mirrorCont ?? this.shadowCont;
    this.imgCont = imgCont ?? this.mirrorCont;
    
    if (!(this.imgCont instanceof HTMLElement)) {
      throw new TypeError(
          "ImgView constructor argument 'imgCont': " + 
          "does not extend HTMLElement class.");
    }
  }
  
  /* The Promise object that is returned by a Tween's then() method is not 
   * rejected when the animation has been interrupted. In combination with the 
   * async/await syntax, this can permanently halt the respective function. 
   * Therefore, I promisify those GSAP animations myself. */
  setOpacity(amount, duration = 0) {
    return new Promise((resolve, reject) => {
      gsap.to(this.rootCont, {
        duration: duration, 
        autoAlpha: amount, 
        overwrite: 'auto', 
        onComplete: resolve, 
        onInterrupt: reject
      });
    });
  }
  
  setFilter(str, duration = 0) {
    return new Promise((resolve, reject) => {
      gsap.to(this.filterCont, {
        duration: duration, 
        filter: str, 
        overwrite: 'auto', 
        onComplete: resolve, 
        onInterrupt: reject
      });
    });
  }
  
  setScaleX(amount, duration = 0) {
    return new Promise((resolve, reject) => {
      gsap.to(this.mirrorCont, {
        duration: duration, 
        scaleX: amount, 
        overwrite: 'auto', 
        onComplete: resolve, 
        onInterrupt: reject
      });
    });
  }
  
  setScaleY(amount, duration = 0) {
    return new Promise((resolve, reject) => {
      gsap.to(this.mirrorCont, {
        duration: duration, 
        scaleY: amount, 
        overwrite: 'auto', 
        onComplete: resolve, 
        onInterrupt: reject
      });
    });
  }
  
  setImg(url, classList = []) {
    // Manages zero or one img element.
    this.removeImg();
    
    this.#img = document.createElement('img');
    this.#img.classList.add(...classList);
    this.imgCont.appendChild(this.#img);
    
    return new Promise((resolve, reject) => {
      // Resolves when the source was successfully loaded.
      this.#img.onload = 
          () => resolve(this.#img);
      
      this.#img.onerror = 
          () => reject(new Error(`Couldn't load '${url}'.`));
      
      // Has to be placed after onload() or onerror().
      this.#img.src = url;
    });
  }
  
  removeImg() {
    if (!this.#img) return;
    
    this.imgCont.removeChild(this.#img);
    this.#img = null;
  }
}


/* Imitates the Java class 'CyclicBarrier': "A synchronization aid that allows a 
 * set of threads to all wait for each other to reach a common barrier point. The 
 * barrier is called cyclic because it can be re-used after the waiting threads 
 * are released." */
class CyclicBarrier {
  waitingParties = [];
  limit;
  
  constructor(limit) {
    this.limit = limit;
  }
  
  release() {
    while (this.waitingParties.length) {
      this.waitingParties
          .pop()
          .call();
    }
  }
  
  // When enough calls were registered, all Promises are resolved at once.
  register() {
    return new Promise((resolve, reject) => {
      this.waitingParties.push(resolve);
      
      if (this.waitingParties.length >= this.limit) {
        this.release();
      }
    });
  }
}


// Holds the data per slot and defines more complex animation sequences.
class MonsterSlot {
  static maxOpacityBg = '{{bgOpacity}}%';
  static maxOpacityFg = '{{fgOpacity}}%';
  
  static okFilter = 'grayscale(0%) brightness(100%)';
  static koFilterBg = 
      'grayscale({{bgKoGrayscale}}%) brightness({{bgKoBrightness}}%)';
  static koFilterFg = 
      'grayscale({{fgKoGrayscale}}%) brightness({{fgKoBrightness}}%)';
  
  static fadingDuration = {{fadingDuration}};
  static koTransDuration = {{koTransDuration}};
  static mirrorTransDuration = {{mirrorTransDuration}};
  
  container;
  viewLayers = {};
  
  /* Overlapping img changes would cause run conditions, therefore the corresponding 
   * methods are blocked. Similar locks for the KO or mirroring animtions cannot
   * be realized, as very long durations would cause problems during the reset. */
  #isImgChangeBlocked = false;
  
  // To avoid unnecessary operations, they are only executed when perceivable.
  #isFgVisible = false;
  
  // Values for SE_API.
  #urlFg = '';
  #isKo = false;
  #scaleVector;
  
  constructor(parent, urlBg, defaultScaleVector = {x: 1, y: 1}) {
    if (!(parent instanceof HTMLElement)) {
      throw new TypeError(
          "MonsterSlot constructor argument 'parent': " + 
          "does not extend HTMLElement class.");
      
    } else if ((typeof defaultScaleVector !== 'object') || 
                      (defaultScaleVector === null)) {
      throw new TypeError(
          "MonsterSlot constructor argument 'defaultScaleVector': " + 
          "is not an object.");
      
    } else if ((typeof defaultScaleVector.x !== 'number') || 
               (typeof defaultScaleVector.y !== 'number')) {
      throw new TypeError(
          "MonsterSlot constructor argument 'defaultScaleVector': " + 
          "properties 'x' and 'y' must be of type number.");
    }
    
    // Represents the mirroring state.
    this.#scaleVector = {
      components: {
        x: defaultScaleVector.x, 
        y: defaultScaleVector.y
      }, 
      isMirroredAcross: {
        x: false, 
        y: false
      }, 
      mirrorX() {
        this.isMirroredAcross.x = !this.isMirroredAcross.x;
      }, 
      mirrorY() {
        this.isMirroredAcross.y = !this.isMirroredAcross.y;
      }, 
      get x() {
        return this.components.x * (this.isMirroredAcross.x ? -1 : 1);
      }, 
      get y() {
        return this.components.y * (this.isMirroredAcross.y ? -1 : 1);
      }, 
      resetMirroring() {
        this.isMirroredAcross.x = false;
        this.isMirroredAcross.y = false;
      }
    };
    
    // Outermost individual wrapper.
    this.container = document.createElement('div');
    this.container.classList.add('monster-slot');
    
    // These classes are CSS-wise the only difference between the layers.
    const distinctiveCssClasses = {
      bg: 'monster-background', 
      fg: 'monster-foreground'
    };
    
    /* Each species of animation inhabits its own layer. This arrangement was 
     * choosen so that they do not influence each other in undesired ways. (A 
     * less complex setup had the disadvantage that the mirroring affected the 
     * shadow cast etc.) */
    for (const prop in distinctiveCssClasses) {
      const rootCont = document.createElement('div');
      rootCont.classList.add('monster-layer', distinctiveCssClasses[prop]);
      this.container.appendChild(rootCont);
      
      const filterCont = document.createElement('div');
      filterCont.classList.add('monster-layer', 'filter-layer');
      rootCont.appendChild(filterCont);
      
      const shadowCont = document.createElement('div');
      shadowCont.classList.add('monster-layer', 'shadow-layer');
      filterCont.appendChild(shadowCont);
      
      const mirrorCont = document.createElement('div');
      mirrorCont.classList.add('monster-layer', 'mirror-layer');
      shadowCont.appendChild(mirrorCont);
      
      const viewLayer = new ImgView(
          rootCont, filterCont, shadowCont, mirrorCont);
      
      // Set default values, to ensure that the first animation isn't skipped.
      viewLayer.setOpacity(0);
      viewLayer.setFilter(MonsterSlot.okFilter);
      viewLayer.setScaleX(this.#scaleVector.x);
      viewLayer.setScaleY(this.#scaleVector.y);
      
      this.viewLayers[prop] = viewLayer;
    }
    
    // Set background img and fade it in, if provided.
    if (urlBg) {
      this.viewLayers.bg.setImg(urlBg)
          .then(() => {
            this.viewLayers.bg.setOpacity(
                MonsterSlot.maxOpacityBg, MonsterSlot.fadingDuration);
          });
    }
    
    parent.appendChild(this.container);
  }
  
  applyKoFilter() {
    if (this.#isKo || !this.#isFgVisible) {
      return Promise.reject(new Error("no change"));
    }
    
    this.#isKo = true;
    
    return Promise.all([
      this.viewLayers.bg.setFilter(
          MonsterSlot.koFilterBg, MonsterSlot.koTransDuration), 
      
      this.viewLayers.fg.setFilter(
          MonsterSlot.koFilterFg, MonsterSlot.koTransDuration)
    ]);
  }
  
  undoKoFilter() {
    /* The visibility of the foreground is not of importance, as this method is 
     * also used to reset cleared slots. */
    if (!this.#isKo) {
      return Promise.reject(new Error("no change"));
    }
    
    this.#isKo = false;
    
    return Promise.all([
      this.viewLayers.bg.setFilter(
          MonsterSlot.okFilter, MonsterSlot.koTransDuration), 
      
      this.viewLayers.fg.setFilter(
          MonsterSlot.okFilter, MonsterSlot.koTransDuration)
    ]);
  }
  
  mirrorFgX() {
    if (!this.#isFgVisible) {
      return Promise.reject(new Error("no change"));
    }
    
    this.#scaleVector.mirrorX();
    
    return this.viewLayers.fg.setScaleX(
        this.#scaleVector.x, MonsterSlot.mirrorTransDuration);
  }
  
  mirrorFgY() {
    if (!this.#isFgVisible) {
      return Promise.reject(new Error("no change"));
    }
    
    this.#scaleVector.mirrorY();
    
    return this.viewLayers.fg.setScaleY(
        this.#scaleVector.y, MonsterSlot.mirrorTransDuration);
  }
  
  async swapFg(url, barrier) {
    try {
      if (this.#isImgChangeBlocked) {
        throw new Error("blocked");
        
      } else if (!url) {
        throw new Error("no change");
      }
      
    } catch (err) {
      /* Would otherwise block the execution, since the barrier expects a certain 
       * number of invocations. */
      if (barrier) {
        barrier.register();
      }
      
      throw err;
    }
    
    this.#isImgChangeBlocked = true;
    this.#urlFg = url;
    
    const promises = [];
    const preloadLink = document.createElement('link');
    
    try {
      // Uses the time that a (possible) fade-out takes to preload the image.
      preloadLink.href = url;
      preloadLink.rel = 'preload';
      preloadLink.as = 'image';
      document.head.appendChild(preloadLink);
      
      // If an img is currently displayed, fade it out.
      if (this.#isFgVisible) {
        this.#isFgVisible = false;
        
        await this.viewLayers.fg.setOpacity(0, MonsterSlot.fadingDuration);
        
        // A newly switched-in monster should never be incapacitated.
        if (this.#isKo) {
          promises.push(this.undoKoFilter());
        }
      }
      
      /* Synchronizes the fade-in animations, as they can only run after all 
       * fade-out animations have completed. */
      if (barrier) {
        await barrier.register();
      }
      
      // Reset mirroring.
      this.#scaleVector.resetMirroring();
      this.viewLayers.fg.setScaleX(this.#scaleVector.x);
      this.viewLayers.fg.setScaleY(this.#scaleVector.y);
      
      await this.viewLayers.fg.setImg(url);
      
      // After the img has been loaded successfully, fade it in.
      promises.push(
          this.viewLayers.fg.setOpacity(
              MonsterSlot.maxOpacityFg, MonsterSlot.fadingDuration));
      
      this.#isFgVisible = true;
      
    } catch (err) {
      /* If an error occurred, the foreground layer should still be hidden. To 
       * maintain consistency between the view and the data model, the URL is 
       * cleared as well. */
      this.#urlFg = '';
      
      throw err;
      
    } finally {
      await Promise.allSettled(promises);
      
      this.#isImgChangeBlocked = false;
      
      // Preload is no longer needed.
      preloadLink.remove();
    }
  }
  
  async clearFg() {
    if (this.#isImgChangeBlocked) {
      throw new Error("blocked");
      
    } else if (!this.#isFgVisible) {
      throw new Error("no change");
    }
    
    this.#isImgChangeBlocked = true;
    this.#urlFg = '';
    this.#isFgVisible = false;
    
    const promises = [];
    
    try {
      await this.viewLayers.fg.setOpacity(0, MonsterSlot.fadingDuration);
      
      this.viewLayers.fg.removeImg();
      
      // A cleared slot cannot be incapacitated.
      if (this.#isKo) {
        promises.push(this.undoKoFilter());
      }
      
    } finally {
      await Promise.allSettled(promises);
      
      this.#isImgChangeBlocked = false;
    }
  }
  
  extractData() {
    return {
      urlFg: this.#urlFg, 
      isKo: this.#isKo, 
      scaleVector: {...this.#scaleVector.components}, 
      isMirroredAcross: {...this.#scaleVector.isMirroredAcross}
    }
  }
  
  async restore(data, barrier) {
    if ((typeof data !== 'object') || (data === null)) {
      throw new TypeError(
          "restore() argument 'data' is not a valid object.");
    }
    
    if (!data.urlFg) {
      try {
        await this.clearFg();
        
      } finally {
        /* Only the first invocation could be moved into 'clear()', as there is 
         * only one in 'swapFg()' as well. I decided to keep everything in one 
         * place. */
        if (barrier) {
          await barrier.register();         // Sync all fade-outs.
          await barrier.register();         // Block until all animations ended.
        }
      }
      
      return;
    }
    
    await this.swapFg(data.urlFg, barrier);
    
    // Block img changes until the state is fully restored.
    this.#isImgChangeBlocked = true;
    
    const promises = [];
    
    if (data.isKo) {
      promises.push(this.applyKoFilter());
    }
    
    /* Previous mirror settings are restored only if the default mirroring 
     * didn't change. This is done because such a major change should result in 
     * a re-evaluation by an user. */
    if ((data.scaleVector.x === this.#scaleVector.components.x) && 
        (data.scaleVector.y === this.#scaleVector.components.y)) {
      
      if (data.isMirroredAcross.x) {
        promises.push(this.mirrorFgX());
      }
      
      if (data.isMirroredAcross.y) {
        promises.push(this.mirrorFgY());
      }
    }
    
    // Rejected Promises should be catched by this.
    await Promise.allSettled(promises);
    
    /* All involved slots are blocked as long as any animation is still running.
     * Otherwise, changes might only apply to a subset of slots. (Those without
     * animations would already accept changes, while those with animations are 
     * blocked and keep their old state.) */
    if (barrier) {
      await barrier.register();
    }
    
    this.#isImgChangeBlocked = false;
  }
}


/* Encapsulate the name-resolution-mechanism. This version is realized via 
 * thefyrewire pastebin API. */
class FyreArgResolver {
  fyreUrl_base;
  
  constructor(pastebinUrl) {
    if (typeof pastebinUrl !== 'string') {
      throw new TypeError(
          "FyreArgResolver constructor argument 'pastebinUrl': " + 
          "type 'string' expected.");
    }
    
    // Extract substring after the last '/' of the pastebin URL.
    const pastebinId = /[^/]*$/.exec(pastebinUrl)[0];
    
    if (!pastebinId) {
      throw new Error(
          "FyreArgResolver constructor argument 'pastebinUrl': " + 
          "could not extract pastebin ID from URL.");
    }
    
    // Base link for Fyre API.
    this.fyreUrl_base = 
        `https://api.thefyrewire.com/twitch/pastebin/${pastebinId}?filter=`;
  }
  
  // Converts all keys to lower case before testing for equality.
  #lowerCaseObjectSearch(obj, searchKey) {
    for (const prop in obj) {
      // 'searchKey' should be already lower case.
      if (searchKey === prop.toLowerCase()) {
        return obj[prop];
      }
    }
  }
  
  /* Looks for a different key at each recursion level and returns the first 
   * actual value while traversing. */
  #recursiveSearchRelay(obj, keyArr, i) {
    // If further recursion is possible, search for the current key.
    if (typeof obj === 'object') {
      if (i < keyArr.length) {
        return this.#recursiveSearchRelay(
            this.#lowerCaseObjectSearch(obj, keyArr[i]), 
            keyArr, 
            i + 1);
        
      /* Allows a shorthand notation, by assuming an implied last key. This way, 
       * a default key is used if the search hasn't led to an actual result. */
      } else {
        return this.#lowerCaseObjectSearch(obj, "default");
      }
      
    // If an actual result is found, return it (and ignore excess keys).
    } else {
      return obj;
    }
  }
  
  /* Uses command args to query a pastebin.com document and to figure out which 
   * value to return from the resulting JSON structure. */
  async query(commandArgs) {
    // RESTful Pastebin API.
    const fyreUrl = this.fyreUrl_base + encodeURIComponent(commandArgs[0]);
    const response = await fetch(fyreUrl);
    
    if (!response.ok) {
      throw new Error(`HTTP error: ${response.status}`);
    }
    
    let pastebinEntry;
    
    try {
      pastebinEntry = await response.json();
    } catch (err) {
      throw new Error("An error occured while parsing JSON.");
    }
    
    // Ignores the first element, since it was already evaluated.
    const result = this.#recursiveSearchRelay(pastebinEntry, commandArgs, 1);
    
    if (!result) {
      throw new Error(`No match found using args: ${commandArgs}`);
    }
    
    return result;
  }
}


/* Stores the data of all slots in a memento object. (Naming convention follows 
 * the Memento pattern.) */
function createMemento() {
  const data = [];
  
  for (const slot of monsterSlots) {
    data.push(slot.extractData());
  }
  
  return {slots: data};
}


// Persistently stores a memento object under a specified name in the SE_API store.
function saveMemento(keyName) {
  SE_API.store.set(keyName, createMemento());
}


// Convenience function for the delayed saving mechanism.
function saveStatusQuo() {
  saveMemento(storeKeys.statusQuo);
  timeoutId = null;
  
  //console.log("Changes saved.");
}


/* Passes each element of the iterable to the function and eventually resolves 
 * the returned Promise object with an array of results. */
function asyncMap(iterable, callbackFn) {
  const promises = [];
  
  for (const element of iterable) {
    promises.push(
        callbackFn(element));
  }
  
  return Promise.allSettled(promises);
}


/* Set slot data to what is stored in the memento object. (Naming convention 
 * follows the Memento pattern.) */
function restoreMemento(memento) {
  const mementoIter = memento.slots[Symbol.iterator]();
  
  // Synchronizes the fade-in phase.
  const barrier = new CyclicBarrier(monsterSlots.length);
  
  /* Each time the passed function is called, it uses another value. This is due 
   * to the changed state in the referred iterator object. So each slot gets its
   * own data. */
  return asyncMap(
      monsterSlots, (slot) => slot.restore(mementoIter.next().value, barrier));
}


// Query the SE_API for slot data and try to restore it.
async function loadMemento(keyName) {
  const memento = await SE_API.store.get(keyName);
  
  if (!memento) {
    throw new Error(
        `SE_API didn't return an object for key '${keyName}'.`);
  }
  
  /* If there is less data to restore than slots available, pad the divergence 
   * with empty objects. Not necessary for mementos in memory, as those inevitably 
   * do have the correct number of slots (a change of the respective option would 
   * cause a widget reload). */
  while (memento.slots.length < monsterSlots.length) {
    memento.slots.push({});
  }
  
  return await restoreMemento(memento);
}


/* Splits a string at the spaces, but ignores those that appear within quotation
 * marks. */
function parseArgs(str) {
  let args = [];
  
  if (typeof str === 'string') {
    // Reduces multiple whitespaces and splits the string.
    const arr = str
        .replace(/\s+/g, ' ')
        .match(/(?:[^\s"']+|['"][^'"]*["'])+/g);
    
    if (arr) {
      // If there were matches, get rid of quotation marks that may occur.
      args = arr.map(s => s.replace(/["']/g, ""));
    }
  }
  
  return args;
}


// Determines which slots are affected.
function parseSlotNumber(str) {
  let slots = [];
  
  if (typeof str === 'string') {
    if (str === keywords.slotWildcard) {
      return monsterSlots;
    }
    
    /* Strings that don't represent a valid number should result in 'NaN'. Any 
     * floating point part is ignored. */
    const n = parseInt(str);
    
    if (!isNaN(n) && (n >= 1) && (n <= monsterSlots.length)) {
      slots.push(monsterSlots[n - 1]);
    }
  }
  
  return slots;
}


// Executes the actions associated with the keywords.
async function interpretKeywords(args) {
  let results = Promise.resolve([]);
  
  /* 'args[1]' is interpreted since 'args[0]' would represent the slot number in
   * this constellation. */ 
  if (args[1] === keywords.clearFg) {
    results = asyncMap(
        parseSlotNumber(args[0]), (slot) => slot.clearFg());
    
  } else if (args[1] === keywords.incapacitateSlot) {
    results = asyncMap(
        parseSlotNumber(args[0]), (slot) => slot.applyKoFilter());
    
  } else if (args[1] === keywords.reviveSlot) {
    results = asyncMap(
        parseSlotNumber(args[0]), (slot) => slot.undoKoFilter());
    
  } else if (args[1] === keywords.mirrorFgX) {
    results = asyncMap(
        parseSlotNumber(args[0]), (slot) => slot.mirrorFgX());
    
  } else if (args[1] === keywords.mirrorFgY) {
    results = asyncMap(
        parseSlotNumber(args[0]), (slot) => slot.mirrorFgY());
    
  // Actions that affect all slots use 'args[0]'.
  } else if (args[0] === keywords.undoChange) {
    if (caretaker.hasPreceding()) {
      results = restoreMemento(caretaker.popPreceding());
    }
    
  } else if (args[0] === keywords.saveState) {
    saveMemento(storeKeys.saveState);
    
    visualizeSaveState();
    
  } else if (args[0] === keywords.loadState) {
    results = loadMemento(storeKeys.saveState);
    
  } else if (args[0] === keywords.reloadFgs) {
    // Reload should never create a changed result.
    loadMemento(storeKeys.statusQuo);
    
  /* If no keyword was recognized, the args are used for querying the pastebin 
   * document. */
  } else if (argsToUrlResolver) {
    let url = "";
    
    try {
      // The first element is the slot number, therefore skipped.
      url = await argsToUrlResolver.query(args.slice(1));
    } catch (err) { }
    
    const slots = parseSlotNumber(args[0]);
    
    // 'slots.length' should be either 1 or the number of available slots.
    const barrier = new CyclicBarrier(slots.length);
    
    results = asyncMap(
        slots, (slot) => slot.swapFg(url, barrier));
  }
  
  return await results;
}


/* To avoid unnecessary calculations, the cooldown is represented by an epoch 
 * time that marks the moment, when it has ended. Later code then simply compares 
 * this to the current epoch time. */
function activateCooldown() {
  cooldownEndEpoch = Date.now() + cooldownMillis;
}


function isOnCooldown() {
  return (Date.now() < cooldownEndEpoch);
}


/* I decided to provide 8 shadow cast directions, to allow an utilization for 
 * outlining as well (multiple overlapping shadows). */
function buildDropShadowFilter(hasShadowCastTowards, offset, blurRadius, color) {
  let outlineCss = "";
  
  const dropShadow = (offsetX, offsetY) => {
    return ` drop-shadow(${offsetX}px ${offsetY}px ${blurRadius}px ${color}) `;
  }
  
  if (hasShadowCastTowards.N)  outlineCss += dropShadow(0,       -offset);
  if (hasShadowCastTowards.NE) outlineCss += dropShadow(offset,  -offset);
  if (hasShadowCastTowards.E)  outlineCss += dropShadow(offset,  0);
  if (hasShadowCastTowards.SE) outlineCss += dropShadow(offset,  offset);
  if (hasShadowCastTowards.S)  outlineCss += dropShadow(0,       offset);
  if (hasShadowCastTowards.SW) outlineCss += dropShadow(-offset, offset);
  if (hasShadowCastTowards.W)  outlineCss += dropShadow(-offset, 0);
  if (hasShadowCastTowards.NW) outlineCss += dropShadow(-offset, -offset);
  
  return outlineCss || 'none';
}


// Appends new CSS rules.
function appendStyleSheet(content) {
  const sheet = document.createElement('style');
  sheet.type = 'text/css';
  
  sheet.innerHTML = content
  
  document.head.appendChild(sheet);
}


// Defines the default mirroring of the foreground img.
function buildScaleVector(mode) {
  const scaleVector = {x: 1, y: 1};
  
  // '-1' translates to 'mirrored across the corresponding axis'.
  switch(mode) {
    case 'xAxis': 
      scaleVector.x = -1;
      break;
      
    case 'yAxis': 
      scaleVector.y = -1;
      break;
      
    case 'xyAxis': 
      scaleVector.x = -1;
      scaleVector.y = -1;
      break;
      
    case 'off':
      break;
      
    default: 
      throw new Error(`Unknown scale vector mode: ${mode}`);
  }
  
  return scaleVector;
}


async function onWidgetLoad(obj) {
  const fieldData = obj.detail.fieldData;
  
  /* Only the beginning of a chat message is evaluated. To avoid false-positive 
   * matches, whitespace is appended. */
  triggerPhrase = fieldData.command.toLowerCase() + " ";
  
  // If no trigger phrase was specified, the widget should remain blocked.
  if (triggerPhrase === " ") {
    console.log("Deactivate widget.");
    return;
  }
  
  // To make all keywords case-insensitive, they're converted to lower case.
  for (const prop in keywords) {
    keywords[prop] = keywords[prop].toLowerCase();
  }
  
  /* The command text is part of the key, to make sure that each individually 
   * addressable widget has its own persistent values. */
  const storeKeyComponents = 
      [fieldData.widgetName, "_v", fieldData.widgetVersion, "_", fieldData.command];
  
  /* Results in a lowercase string in which ...
   * ... spaces have been replaced with underscores.
   * ... non-alphanumeric characters have been replaced with their hex values. */
  storeKeys.base = storeKeyComponents
      .join('')
      .toLowerCase()
      .replace(/\s/g, '_')
      .replace(/\W/g, (s) => s.charCodeAt(0).toString(16));
  
  storeKeys.statusQuo = storeKeys.base + "_statusquo";
  storeKeys.saveState = storeKeys.base + "_savestate";
  
  // Name-resolution mechanism.
  try {
    argsToUrlResolver = new FyreArgResolver(fieldData.fgPastebinUrl);
    
    console.log(`Fyre base link: ${argsToUrlResolver.fyreUrl_base}`);
    
  } catch (err) {
    console.log(err.message);
  }
  
  // Defines who can use the widget.
  isUsableByMods = (fieldData.permissionLvl === 'mods');
  
  otherUsers = fieldData.otherUsers
      .replace(/\s/g, '')
      .toLowerCase()
      .split(",");
  
  blockedUsers = fieldData.blockedUsers
      .replace(/\s/g, '')
      .toLowerCase()
      .split(",");
  
  // Global cooldown.
  cooldownMillis = fieldData.cooldown * 1000;
  
  // Defines foreground shadows.
  const hasShadowCastTowards = {
    N:  fieldData.fgShadowN, 
    NE: fieldData.fgShadowNe, 
    E:  fieldData.fgShadowE, 
    SE: fieldData.fgShadowSe, 
    S:  fieldData.fgShadowS, 
    SW: fieldData.fgShadowSw, 
    W:  fieldData.fgShadowW, 
    NW: fieldData.fgShadowNw
  };
  
  const fgDropShadowFilter = buildDropShadowFilter(
      hasShadowCastTowards, 
      fieldData.fgShadowOffset, 
      fieldData.fgShadowBlurRadius, 
      fieldData.fgShadowColor);
  
  appendStyleSheet(
      `.monster-foreground .shadow-layer {
         filter: ${fgDropShadowFilter};
       }`);
  
  // Append MonsterSlot Proxies.
  const mainContainer = document.getElementsByClassName('main-container')[0];
  const scaleVector = buildScaleVector(fieldData.fgDefaultMirroring);
  
  for (let i = 0; i < fieldData.slotQuantity; i++) {
    monsterSlots[i] = 
        new MonsterSlot(mainContainer, fieldData.bgUrl, scaleVector);
  }
  
  // Triggered when a save state is created to give some visual feedback.
  visualizeSaveState = () => {
    gsap.fromTo(".main-container", {
      filter: "invert(1)"
    }, {
      filter: "invert(0)", 
      duration: fieldData.saveStateAnimationDuration, 
      ease: "power4.in"
    });
  }
  
  /* Test mode doesn't set persistent values. When deactivated, the previous 
   * values will be restored. */
  if (fieldData.testModeGeneral === 'on') {
    
    // Is there a border visualization?
    if (fieldData.testModeSlotBorder === "on") {
      appendStyleSheet(
          `.monster-slot {
            border: 1px solid black;
          }`);
    }
    
    // Creates a test memento and restores it.
    const args = parseArgs(
        fieldData.testArgs.toLowerCase());
    
    let testUrl = '';
    
    // Less than 1 arg means a syntactical error.
    if (argsToUrlResolver && args.length >= 1) {
      console.log(`Simulated command args: ${args}`);
      
      try {
        testUrl = await argsToUrlResolver.query(args);
      } catch (err) { }
      
      console.log(`Uses testUrl: ${testUrl}`);
    }
    
    const testData = {
      urlFg: testUrl, 
      isKo: (fieldData.testModeKo === "on"), 
      scaleVector: scaleVector, 
      isMirroredAcross: {
        x: (fieldData.testModeMirrorX === "on"), 
        y: (fieldData.testModeMirrorY === "on")
      }
    };
    
    const testMemento = {
      slots: Array(monsterSlots.length).fill(testData)
    };
    
    // Each slot receives the same test data.
    restoreMemento(testMemento);
    
  // Loads the last state via SE_API.
  } else {
    try {
      await loadMemento(storeKeys.statusQuo);
      
    } catch (err) {
      console.log(err.massage);
    }
  }
  
  isBlocked = false;
}


async function onMessage(msg) {
  if (isBlocked) {
    //console.log("Widget is currently blocked.");
    return;
  }
  
  if (isOnCooldown()) {
    //console.log("Cooldown is still running.");
    return;
  }
  
  // Blocked users are rejected.
  if (msg.usernameOnList(blockedUsers)) {
    //console.log(`'${msg.username}' is on blocked users list.`);
    return;
  }
  
  // Check if the user has enough permissions for the selected mode.
  if ((isUsableByMods && msg.isModerator()) || 
      msg.isBroadcaster() || 
      msg.usernameOnList(otherUsers)) {
    
    /* To avoid unnecessary processing, only the beginning of the message is 
     * converted to lower case and gets tested. */
    const msgStart = msg.text
        .substring(0, triggerPhrase.length)
        .toLowerCase();
    
    if (msgStart !== triggerPhrase) return;
    
    /* Now that it's established that the chat message begins with the trigger 
     * phrase and that the user is allowed to use the command, the whole message
     * can be processed. The trigger phrase is cut off, to allow for white space
     * in it. */
    const args = parseArgs(
        msg.text
            .substring(triggerPhrase.length)
            .toLowerCase());
    
    // Less than 1 arg means a syntactical error.
    if (args.length < 1) return;
    
    isBlocked = true;
    activateCooldown();
    
    // State before a possible change was made.
    const memento = createMemento();
    let hasChanged = false;
    
    try {
      // Initialization of the resolver object is tested in 'interpretKeywords'.
      const results = await interpretKeywords(args);
      
      // At least 1 fulfilled Promise means a changed state.
      hasChanged = results.some(
          (result) => (result.status === 'fulfilled'));
      
    } catch (err) {
      console.log(err.massage);
    }
    
    if (hasChanged) {
      /* Undone changes do not end up on the undo stack, since otherwise the 
       * stack couldn't reduce in size and would just switch back and forth 
       * between the last two states instead. */
      if (args[0] !== keywords.undoChange) {
        caretaker.push(memento);
      }
      
      /* All changes in the next 30 seconds are "buffered". Very frequent SE_API
       * calls could otherwise cause a timeout. */
      if (!timeoutId) {
        timeoutId = setTimeout(saveStatusQuo, saveDelayMillis);
      }
      
      //console.log("Something has changed.");
    }
    
    isBlocked = false;
  }
}


// If the widget is about to get closed, save any yet unsaved changes.
window.addEventListener("beforeunload", function() {
  if(timeoutId) {
    clearTimeout(timeoutId);
    saveStatusQuo();
  }
});
