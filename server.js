const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');
const { spawn, exec } = require('child_process');

const app = express();
const PORT = 3000;

app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

const COORDINATES_FILE = path.join(__dirname, 'coordinates.json');
let botProcess = null;

// Get all actions
app.get('/api/actions', (req, res) => {
    try {
        const data = fs.readFileSync(COORDINATES_FILE, 'utf8');
        res.json(JSON.parse(data));
    } catch (err) {
        res.status(500).json({ error: 'Failed to read coordinates file' });
    }
});

// Save all actions
app.post('/api/actions', (req, res) => {
    try {
        const actions = req.body;
        fs.writeFileSync(COORDINATES_FILE, JSON.stringify(actions, null, 4));
        res.json({ success: true, message: 'Actions saved successfully' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to save coordinates file' });
    }
});

// Start Bot
app.post('/api/bot/start', (req, res) => {
    if (botProcess) {
        return res.status(400).json({ error: 'Bot is already running' });
    }

    console.log('Starting bot...');
    botProcess = spawn('node', ['bot_visual.js'], {
        cwd: __dirname,
        shell: true
    });

    botProcess.stdout.on('data', (data) => {
        console.log(`[BOT]: ${data}`);
    });

    botProcess.stderr.on('data', (data) => {
        console.error(`[BOT ERROR]: ${data}`);
    });

    botProcess.on('close', (code) => {
        console.log(`Bot process exited with code ${code}`);
        botProcess = null;
    });

    res.json({ success: true, message: 'Bot started' });
});

// Stop Bot
app.post('/api/bot/stop', (req, res) => {
    if (!botProcess) {
        return res.status(400).json({ error: 'Bot is not running' });
    }

    console.log(`Stopping bot (PID: ${botProcess.pid})...`);
    
    // Kill specific process tree based on PID
    exec(`taskkill /pid ${botProcess.pid} /T /F`, (err, stdout, stderr) => {
        if (err) {
            console.error('Error killing process:', err);
            // Fallback
            botProcess.kill();
        }
        botProcess = null;
        res.json({ success: true, message: 'Bot stopped' });
    });
});

// Restart Bot
app.post('/api/bot/restart', (req, res) => {
    const startBot = () => {
        console.log('Restarting bot...');
        botProcess = spawn('node', ['bot_visual.js'], {
            cwd: __dirname,
            shell: true
        });

        botProcess.stdout.on('data', (data) => {
            console.log(`[BOT]: ${data}`);
        });

        botProcess.stderr.on('data', (data) => {
            console.error(`[BOT ERROR]: ${data}`);
        });

        botProcess.on('close', (code) => {
            console.log(`Bot process exited with code ${code}`);
            botProcess = null;
        });
        
        res.json({ success: true, message: 'Bot restarted' });
    };

    if (botProcess) {
        console.log(`Stopping bot for restart (PID: ${botProcess.pid})...`);
        exec(`taskkill /pid ${botProcess.pid} /T /F`, (err) => {
            if (err) console.error('Error killing process during restart:', err);
            botProcess = null;
            // Wait a bit to ensure files are released
            setTimeout(startBot, 1000);
        });
    } else {
        startBot();
    }
});

// Get Bot Status
app.get('/api/bot/status', (req, res) => {
    res.json({ running: !!botProcess });
});

app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});
