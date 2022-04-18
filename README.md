# MonsterTeamVisualizer
This StreamElements custom widget attempts to make the visualization of monster teams easier, reusable and manageable by (particular) chat users.

Special thanks to thefyrewire, Reboot0, pjonp, lx, Zaytri, johnny8769 and SquidCharger.


## Description of operation:
The widget allows to manage multiple image slots via chat commands. Those slots can be populated from a pool of images ("pool" means here a [pastebin](https://pastebin.com/) document containing URLs).

Beyond the handling of image changes, it's also capable of ...
 - displaying a monster's combat status.
 - mirroring of the foreground image (if needed).
 - creating and loading of a savestate.

See also this [demonstration video](https://www.youtube.com/watch?v=nkINbIKWw3o).


## Command types:
Spaces are used as separators between the individual parts of the chat command (except for those in the associated command phrase or within quotation marks).

For *slot commands* the first element after the command phrase is interpreted as a slot number.  
The placeholder `n` can be a single valid number or `*` (selects all slots).

### Slot commands:
 - `!slot n tag keyLvl1 keyLvl2 ... keyLvlN` 
   
   Changes the displayed image.
   
   The syntax follows the structure defined by the particular pastebin entry.  
   Command parts are interpreted as: *slot number*, *tag*, then *keys* (one key per nesting level).
   
   For further information see the example section.
   
 - `!slot n clear`
   
   Clears the slot of any foreground images.
   
 - `!slot n ko`
   
   Applies some filters to the slot to emphasize that the associated monster is incapacitated.
   
   This doesn't work for empty slots.
   
 - `!slot n ok`
   
   Revokes `ko` filters.
   
 - `!slot n mirror`
   
   Mirrors the foreground image across the X-axis.
   
   This doesn't work for empty slots.
   
 - `!slot n mirrorY`
   
   Mirrors the foreground image across the Y-axis.
   
   This doesn't work for empty slots.


### Global commands:

 - `!slot undo`
   
   Restores the previous state (the last 5 states are preserved).
   
 - `!slot savestate`
   
   Stores the current state as a savestate (only 1 at this point).
   
 - `!slot loadstate`
   
   Restores the saved state.
   
 - `!slot reload`
   
   Restores the current state (in case that any loading failed because of time-outs).
   
   In the best scenario this is not used at all, since the delayed save mechanism can lead to some strange behavior.


## Structure of pastebin document:
Each line in the pastebin document should follow the formula:
```
:[tag1, tag2, ... tagN] { "key1":"url1", "key2":"url2", ... "keyN":"urlN" }
```

The **left** part of this structure follows the syntax defined by [thefyrewire's API](https://thefyrewire.com/docs/api/twitch/pastebin/), the **right** part follows the [JSON format defintion](https://developer.mozilla.org/en-US/docs/Learn/JavaScript/Objects/JSON#json_structure).  
Of course, this means that the JSON part can contain nesting:
```
:[tag] { "key_lvl1":{ "key_lvl2_1":"url2_1", "key_lvl2_2":"url2_2" } }
```

A shorthand notation can be used later on, if a *"default"* key was provided for the nesting level (see the example section): 
```
:[tag] { "default":"url1", "key2":"url2", "key3":"url3" }
```

If no match is found, a random **untagged** line is choosen.  
Therefore an entry like the following can make sense in some (rare) cases:
```
{ "default":"url1", "key2":"url2" }
```

There is also this [tutorial video](https://www.youtube.com/watch?v=Mdcpda372fs) which shows how to create a proper pastebin document.


## Example:
Let's assume we have a pastebin document with this content:
```
:[1, 001, A] { "default":"some.website/a1.png" }
:[2, 002, B] { "default":"another.website/b1.png", "rare":"another.website/b2.png" }
:[3, 003, C] { "default":"third.website/c1.png", "super":{ "default":"third.website/c2.png", "alt":"third.website/c3.png" } }
:[4, 004, D] { "default":"last.website/d1.png", "super":{ "form1":"last.website/d2.png", "form2":"last.website/d3.png" } }
```

The full command to display `A` in slot `1` would be:
```
!slot 1 a default
```

But since the last argument is *"default"*, it can be omitted (shorthand notation):
```
!slot 1 a
```

To display the `rare` variant of `B` in all slots:
```
!slot * b rare
```

To display the `default super` variant of `C` in the third slot (shorthand notation):
```
!slot 3 c super
```

For the `alternative super` variant of `C`:
```
!slot 3 c super alt
```

Since there is no *"default"* key for D's `super` nesting, it's necessary to specify the last argument:
```
!slot 1 d super form1
!slot 1 d super form2
```
