#!/usr/bin/osascript

-- Phantom Relay: Auto-install Chrome Extension
-- Uses System Events to click through chrome://extensions/

set extensionPath to "/Users/lingion_k/Desktop/phantom-relay/extension"
set extPathPOSIX to extensionPath

tell application "Google Chrome"
    activate
    delay 1
end tell

tell application "System Events"
    tell process "Google Chrome"
        set frontmost to true
        delay 1
        
        -- Step 1: Toggle "Developer mode" if not already on
        -- Look for the developer mode toggle (usually a button or switch)
        try
            set devToggle to first button of group 1 of toolbar 1 of window 1 whose description contains "Developer mode"
            set devState to value of devToggle
            if devState is 0 or devState is false then
                click devToggle
                delay 1
            end if
        on error
            -- Alternative: look for the toggle in the main content area
            try
                set devToggle to checkbox 1 of window 1 whose title contains "Developer mode"
                if value of devToggle is 0 then
                    click devToggle
                    delay 1
                end if
            on error
                log "Can't find Developer mode toggle -- it may already be enabled"
            end try
        end try
        
        delay 1
        
        -- Step 2: Click "Load unpacked" button
        try
            click button "Load unpacked" of window 1
            delay 1.5
        on error
            try
                -- May have different label
                set allButtons to buttons of window 1
                repeat with b in allButtons
                    set btnDesc to description of b
                    set btnTitle to title of b
                    if btnDesc contains "Load unpacked" or btnTitle contains "Load unpacked" then
                        click b
                        delay 1.5
                        exit repeat
                    end if
                end repeat
            on error errMsg
                log "Could not click Load unpacked: " & errMsg
            end try
        end try
        
        -- Step 3: Handle the file picker dialog
        delay 1
    end tell
end tell

-- File picker is a separate process
tell application "System Events"
    -- The file picker is often its own process "CoreServicesUIAgent" or within Finder/Chrome
    delay 1
    
    -- Try multiple approaches for the file dialog
    set dialogFound to false
    
    -- Approach 1: Chrome's own file dialog
    try
        tell process "Google Chrome"
            set frontmost to true
            delay 0.5
        end tell
    end try
    
    -- Approach 2: Generic file dialog
    repeat with procName in {"CoreServicesUIAgent", "Finder", "Google Chrome"}
        try
            tell process (procName as string)
                -- Look for "Go to Folder" sheet or direct path entry
                -- Use Cmd+Shift+G to open "Go to folder" dialog
                keystroke "g" using {command down, shift down}
                delay 1
                
                -- Type the extension path
                keystroke extPathPOSIX
                delay 0.5
                keystroke return
                delay 1
                
                -- Now click "Select" or "Open" button
                try
                    click button "Select" of window 1
                on error
                    try
                        click button "Open" of window 1
                    on error
                        keystroke return
                    end try
                end try
                
                set dialogFound to true
                exit repeat
            end tell
        on error
            -- Try next process
        end try
    end repeat
    
    if not dialogFound then
        log "Warning: Could not automate file dialog. Manual intervention may be needed."
    end if
end tell

log "Phantom Relay installation attempted."
