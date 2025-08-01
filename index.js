import express from "express";
import http from "http";
import bodyParser from "body-parser";
import path from 'path';
import pg from 'pg';
import env from 'dotenv';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';

const app = express();
const PORT = process.env.PORT || 3001;

env.config();

const db = new pg.Client({
  user: process.env.PG_USER,
  host: process.env.PG_HOST,
  database: process.env.PG_DATABASE,
  password: process.env.PG_PASSWORD,
  port: process.env.PG_PORT,
});

const init_score_board = [
  {"pid": 1, "name": "Player 1", "position": "East", "joined": false, "score": 0},
  {"pid": 2, "name": "Player 2", "position": "South", "joined": false, "score": 0},
  {"pid": 3, "name": "Player 3", "position": "West", "joined": false, "score": 0},
  {"pid": 4, "name": "Player 4", "position": "North", "joined": false, "score": 0}
]

// Have Node serve the files for our built React app (needed for code deploy)
const __filename = fileURLToPath(import.meta.url); // get the resolved path to the file
const __dirname = path.dirname(__filename); // get the name of the directory
const buildPath = __dirname + '/build/';
app.use(express.static(buildPath));
// Have Node serve the files for our built React app (needed for code deploy)

app.use(bodyParser.urlencoded({ extended: true }));

db.connect();


/* Support WebSocket server connection */

const WS_PORT = process.env.REACT_APP_WS_PORT || 8080;
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
server.listen(WS_PORT);
/*const wss = new WebSocketServer({ port: 8080 });*/
console.log(`Websocket server listening on port ${WS_PORT}`);

/*
  Example channel format structure
  { gameID : [ { "playerID" : pid, "ws" : ws }, ... , { "playerID" : pid, "ws" : ws } ] }
*/

const channels = {};

wss.on('connection', function connection(ws, request) {

  ws.on('error', console.error);

  const params = new URLSearchParams(request.url.slice(1));
  const gameID = params.get("gid");
  const playerID = params.get("pid");
  subscribe(gameID, playerID, ws);

  function subscribe(gid, pid, wsid) {
    unsubscribe(wsid);
    const newItem = { "playerID" : pid, "ws" : wsid };
    if (channels[gid]) {
      const arrItem = channels[gid];
      let matched = false;
      arrItem.forEach( item => {
        if (item.playerID === pid && item.ws === wsid) {
          matched = true;
        }; 
      });
      if (matched === false) {
        channels[gid].push(newItem);
      };
    } else {
      channels[gid] = [newItem];
    };
    console.log(channels);
  };

  function unsubscribe(wsid) {
    const keys = Object.keys(channels);
    keys.forEach((key) => {
      const arrItem = channels[key];
      const newArray = arrItem.filter( (item) => item.ws !== wsid);
      if (newArray.length > 0) {
        channels[key] = newArray;
      } else {
        delete channels[key];
      };
    });
    console.log(channels);
  };

  /*
  Example websocket client message format structure
  { "action" : "SUBSCRIBE / UNSUBSCRIBE / PING",
    "gameID" : number,
    "playerID" : 1 / 2 / 3 / 4,
    "content" : data }
  */

  ws.on('message', function message(data) {
    const parsed_data = JSON.parse(data);
    const action = parsed_data.action;
    if (action === "SUBSCRIBE") {
      const gameID = parsed_data.gameID;
      const playerID = parsed_data.playerID;  
      subscribe(gameID, playerID, ws);
    } 
    else if (action === "UNSUBSCRIBE") {
      unsubscribe(ws);
    }
    else if (action === "PING") {
      ws.send(JSON.stringify("PONG"));
    } else {
      console.log(parsed_data);
    };
  });

  ws.on('close', () => {
    console.log("Connection for ws is closed");
    unsubscribe(ws);
  });
});

/*
Example websocket server message format structure
{ "action" : "GAMELIST / SCOREBOARD ",                          // for ALL
  "gameID" : My game ID,                                        // for ALL other than GAMELIST
  "playerID" : My player ID // if SCOREBOARD,                   // for ALL other than GAMELIST
  "data" : { "value": 57, "label": "57 - game name for 57" }    // for GAMELIST
           { "result": "success", "score_board": scoreboard }   // for SCOREBOARD fetch success
           { "result": "error", "err_msg": error message text } // for SCOREBOARD fetch fail
}
*/

function sendServerMessage(game_id, player_id, xact_code, data_content) {
  if (xact_code === "GAMELIST") {
    wss.clients.forEach( client => {
      const message = {
        "action": xact_code,
        "data": data_content
      };
      client.send(JSON.stringify(message));
    });
  } else {
    if (channels[game_id]) {
      const arrItem = channels[game_id];
      arrItem.forEach((item) => {
        const message = {
          "action": xact_code,
          "gameID": game_id,
          "playerID": Number(item.playerID),
          "data": data_content
        };
        item.ws.send(JSON.stringify(message));
      });
    };
  };
};

/* Support WebSocket server connection */

async function fetchScoreBoard(gid) {
  try {
    const db_result = await db.query(
      "SELECT pid AS id, name, position, joined, score FROM scoreboard WHERE gid = $1 ORDER BY pid ASC",
      [gid]
    );
    if (db_result.rowCount > 0) {
      return { 
        result: "success",
        score_board: db_result.rows
      };
    } else {
      return {
        result: "error",
        err_msg: "No record selected"
      };
    }
  } catch (err) {
    return {
      result: "error",
      err_msg: "DB error in /scoreboard: " + err
    };
  };
};

app.get("/scoreboard", async (req, res) => {
  const gameID = Number(req.query.gameID);
  const fetch_result = await fetchScoreBoard(gameID);
  res.json(fetch_result);
});

app.get("/gamelist", async (req, res) => {
  
  try {
    const db_select_result = await db.query(
      "SELECT id, name FROM game WHERE completed = $1",
      [false]
    );
    res.json({
      result: "success",
      gamelist: db_select_result.rows
    });
  } catch (err) {
    res.json({
      result: "error",
      err_msg: "DB error in /gamelist: " + err
    });
  };
});

app.get("/activity", async (req, res) => {

  const gameID = Number(req.query.gameID);
  const playerID = Number(req.query.playerID);
  const lastTimestamp = Number(req.query.ts);
  try {
    const db_result = await db.query(
      "SELECT * FROM activity WHERE gid = $1 and ts > $2 and (fid = $3 or tid = $3) ORDER BY ts ASC",
      [gameID, lastTimestamp, playerID]
    );
    if (db_result.rowCount > 0) {
      const fetch_result = await fetchScoreBoard(gameID);
      let scoreboard = [];
      if (fetch_result.result === "success") {
        scoreboard = fetch_result.score_board;
      };
      res.json({ 
        result: "success",
        log: db_result.rows,
        score_board: scoreboard
      });
    } else {
      res.json({
        result: "success",
        log: [],
        score_board: []
      });
    }
  } catch (err) {
    res.json({ 
      result: "error",
      err_msg: "DB error in /activity: " + err
    });
  };

});

app.post("/newgame", async (req, res) => {

  const nameOfGame = req.query.nameOfGame;
  const currentDate = new Date().toISOString().split("T")[0];

  try {
    await db.query("BEGIN");
    const db_insert_result = await db.query(
      "INSERT INTO game (name, currentdate, completed) VALUES ($1, $2, $3) RETURNING id",
      [nameOfGame, currentDate, false]
    );
    if (db_insert_result.rowCount === 1) {
      const gameID = db_insert_result.rows[0].id;

      const db_insert_result1 = await db.query(
        "INSERT INTO scoreboard (gid, pid, name, position, joined, score) VALUES ($1, $2, $3, $4, $5, $6)",
        [gameID, init_score_board[0].pid, init_score_board[0].name, init_score_board[0].position, init_score_board[0].joined, init_score_board[0].score]
      );
      const db_insert_result2 = await db.query(
        "INSERT INTO scoreboard (gid, pid, name, position, joined, score) VALUES ($1, $2, $3, $4, $5, $6)",
        [gameID, init_score_board[1].pid, init_score_board[1].name, init_score_board[1].position, init_score_board[1].joined, init_score_board[1].score]
      );
      const db_insert_result3 = await db.query(
        "INSERT INTO scoreboard (gid, pid, name, position, joined, score) VALUES ($1, $2, $3, $4, $5, $6)",
        [gameID, init_score_board[2].pid, init_score_board[2].name, init_score_board[2].position, init_score_board[2].joined, init_score_board[2].score]
      );
      const db_insert_result4 = await db.query(
        "INSERT INTO scoreboard (gid, pid, name, position, joined, score) VALUES ($1, $2, $3, $4, $5, $6)",
        [gameID, init_score_board[3].pid, init_score_board[3].name, init_score_board[3].position, init_score_board[3].joined, init_score_board[3].score]
      );
      if (db_insert_result1.rowCount === 1 &&
          db_insert_result2.rowCount === 1 &&
          db_insert_result3.rowCount === 1 &&
          db_insert_result4.rowCount === 1) {
        await db.query("COMMIT");
        res.json({
          result: "success", 
          gameID: gameID 
        });
        const newGame = {
              "value": gameID,
              "label": gameID + " - " + nameOfGame 
        };
        sendServerMessage(gameID, 0,"GAMELIST", newGame);
      } else {
        await db.query("ROLLBACK");
        res.json({
          result: "error",
          err_msg: "Record not added"
        });
      };
    } else {
      await db.query("ROLLBACK");
      res.json({
        result: "error",
        err_msg: "Record not added"
      });
    }
  } catch (err) {
    await db.query("ROLLBACK");
    res.json({
      result: "error",
      err_msg: "DB error in /newgame: " + err
    });
  };
});


app.post("/reset", async (req, res) => {
  const gameID = Number(req.query.gameID);
  try {
    await db.query("BEGIN");
    await db.query(
      "DELETE FROM scoreboard WHERE gid = $1",
      [gameID]
    );
    const db_insert_result1 = await db.query(
      "INSERT INTO scoreboard (gid, pid, name, position, joined, score) VALUES ($1, $2, $3, $4, $5, $6)",
      [gameID, init_score_board[0].pid, init_score_board[0].name, init_score_board[0].position, init_score_board[0].joined, init_score_board[0].score]
    );
    const db_insert_result2 = await db.query(
      "INSERT INTO scoreboard (gid, pid, name, position, joined, score) VALUES ($1, $2, $3, $4, $5, $6)",
      [gameID, init_score_board[1].pid, init_score_board[1].name, init_score_board[1].position, init_score_board[1].joined, init_score_board[1].score]
    );
    const db_insert_result3 = await db.query(
      "INSERT INTO scoreboard (gid, pid, name, position, joined, score) VALUES ($1, $2, $3, $4, $5, $6)",
      [gameID, init_score_board[2].pid, init_score_board[2].name, init_score_board[2].position, init_score_board[2].joined, init_score_board[2].score]
    );
    const db_insert_result4 = await db.query(
      "INSERT INTO scoreboard (gid, pid, name, position, joined, score) VALUES ($1, $2, $3, $4, $5, $6)",
      [gameID, init_score_board[3].pid, init_score_board[3].name, init_score_board[3].position, init_score_board[3].joined, init_score_board[3].score]
    );
    if (db_insert_result1.rowCount === 1 &&
        db_insert_result2.rowCount === 1 &&
        db_insert_result3.rowCount === 1 &&
        db_insert_result4.rowCount === 1) {
      await db.query("COMMIT");
      res.json({ 
        result: "success" 
      });
    } else {
      await db.query("ROLLBACK");
      res.json({
        result: "error",
        err_msg: "Reset failed"
      });
    }
  } catch (err) {
    await db.query("ROLLBACK");
    res.json({
      result: "error",
      err_msg: "DB error in /reset: " + err
    });
  };
});


app.post("/transferpoints", async (req, res) => {

  const gameID = Number(req.query.gameID)
  const fromPlayerID = Number(req.query.fromPlayerID);
  const fromPlayerName = req.query.fromPlayerName;
  const toPlayerID = Number(req.query.toPlayerID);
  const toPlayerName = req.query.toPlayerName;
  const points = Number(req.query.points);
  const type = req.query.type;
  const ts = Date.now();
  const cDateTme = new Date(ts).toLocaleDateString() + " " + new Date(ts).toLocaleTimeString();

  try {
    await db.query("BEGIN");
    const db_update_result1 = await db.query(
      "UPDATE scoreboard SET score = score - $1 WHERE gid = $2 AND pid = $3",[points, gameID, fromPlayerID]
    );
    const db_update_result2 = await db.query(
      "UPDATE scoreboard SET score = score + $1 WHERE gid = $2 AND pid = $3",[points, gameID, toPlayerID]
    );
    const db_insert_result1 = await db.query(
      "INSERT INTO activity (gid, ts, datetime, type, fid, fname, tid, tname, score) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
      [gameID, ts, cDateTme, type, fromPlayerID, fromPlayerName, toPlayerID, toPlayerName, points]
    );
    if (db_update_result1.rowCount === 1 && db_update_result2.rowCount === 1 && db_insert_result1) {
      await db.query("COMMIT");
      res.json({ result: "success"});
      const fetch_result = await fetchScoreBoard(gameID);
      sendServerMessage(gameID, toPlayerID, "SCOREBOARD", fetch_result);
    } else {
      await db.query("ROLLBACK");
      res.json({ 
        result: "error",
        err_msg: "Record not updated"
      });
    };
  } catch (err) {
    await db.query("ROLLBACK");
    res.json({ 
      result: "error",
      err_msg: "DB error in /transferpoints: " + err
    });
  };
});


app.post("/transferpointstoall", async (req, res) => {

  const gameID = Number(req.query.gameID)
  const fromPlayerIDs = req.query.fromIDs;
  const fromPlayerNames = req.query.fromNames;
  const toPlayerID = Number(req.query.toID);
  const toPlayerName = req.query.toName;
  const points = Number(req.query.points);
  const type = req.query.type;
  const ts = Date.now();
  const cDateTme = new Date(ts).toLocaleDateString() + " " + new Date(ts).toLocaleTimeString();

  try {
    await db.query("BEGIN");
    const db_update_result1 = await db.query(
      "UPDATE scoreboard SET score = score + $1 WHERE gid = $2 AND pid = $3",[points * 3, gameID, toPlayerID]
    );
    const db_update_result2 = await db.query(
      "UPDATE scoreboard SET score = score - $1 WHERE gid = $2 AND pid = $3",[points, gameID, fromPlayerIDs[0]]
    );  
    const db_update_result3 = await db.query(
      "UPDATE scoreboard SET score = score - $1 WHERE gid = $2 AND pid = $3",[points, gameID, fromPlayerIDs[1]]
    );    
    const db_update_result4 = await db.query(
      "UPDATE scoreboard SET score = score - $1 WHERE gid = $2 AND pid = $3",[points, gameID, fromPlayerIDs[2]]
    );
    const db_insert_result1 = await db.query(
      "INSERT INTO activity (gid, ts, datetime, type, fid, fname, tid, tname, score) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
      [gameID, ts, cDateTme, type, fromPlayerIDs[0], fromPlayerNames[0], toPlayerID, toPlayerName, points]
    );
    const db_insert_result2 = await db.query(
      "INSERT INTO activity (gid, ts, datetime, type, fid, fname, tid, tname, score) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
      [gameID, ts, cDateTme, type, fromPlayerIDs[1], fromPlayerNames[1], toPlayerID, toPlayerName, points]
    );
    const db_insert_result3 = await db.query(
      "INSERT INTO activity (gid, ts, datetime, type, fid, fname, tid, tname, score) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
      [gameID, ts, cDateTme, type, fromPlayerIDs[2], fromPlayerNames[2], toPlayerID, toPlayerName, points]
    );
    if (db_update_result1.rowCount === 1 && 
        db_update_result2.rowCount === 1 &&
        db_update_result3.rowCount === 1 &&
        db_update_result4.rowCount === 1 &&
        db_insert_result1.rowCount === 1 &&
        db_insert_result2.rowCount === 1 &&
        db_insert_result3.rowCount === 1) {
      await db.query("COMMIT");
      res.json({ result: "success"});
      const fetch_result = await fetchScoreBoard(gameID);
      sendServerMessage(gameID, toPlayerID, "SCOREBOARD", fetch_result);
    } else {
      await db.query("ROLLBACK");
      res.json({ 
        result: "error",
        err_msg: "Record not updated"
      });
    };
  } catch (err) {
    await db.query("ROLLBACK");
    res.json({ 
      result: "error",
      err_msg: "DB error in /transferpoints: " + err
    });
  };
});


app.post("/register", async (req, res) => {
  const gameID = Number(req.query.gameID);
  const id = Number(req.query.ID);
  const name_to_register = req.query.name;
  try {
    const db_select_result = await db.query(
      "SELECT name, joined FROM scoreboard WHERE gid = $1 AND pid = $2",
      [gameID, id]
    );
    if (db_select_result.rowCount === 1) {
      const player_name = db_select_result.rows[0].name;
      const player_joined = db_select_result.rows[0].joined;
      if (player_joined === false) {
        try {
          const db_update_result = await db.query(
            "UPDATE scoreboard SET name = $1, joined = $2 WHERE gid = $3 AND pid = $4",
            [name_to_register, true, gameID, id]
          );
          res.json({ result: "success"});
          const fetch_result = await fetchScoreBoard(gameID);
          sendServerMessage(gameID, id, "SCOREBOARD", fetch_result);
        } catch (err) {
          res.json({ 
            result: "error",
            err_msg: "DB error in /register: " + err
          });
        };
      } else if (player_name === name_to_register) {
        res.json({ result: "success"});
      } else {
        res.json({ result: "fail"});
      };
    } else {
      res.json({ 
        result: "error",
        err_msg: "Record not found"
      })
    }
  } catch (err) {
    res.json({ 
      result: "error",
      err_msg: "DB error in /register: " + err
    });
  };
});


app.post("/release", async (req, res) => {
  const gameID = Number(req.query.gameID);
  const id = Number(req.query.ID);
  try {
    const db_update_result = await db.query(
      "UPDATE scoreboard SET joined = $1 WHERE gid = $2 AND pid = $3",
      [false, gameID, id]
    );

    if (db_update_result.rowCount === 1) {
      res.json({ result: "success" });
      const fetch_result = await fetchScoreBoard(gameID);
      sendServerMessage(gameID, id, "SCOREBOARD", fetch_result);
    } else {
      res.json({ 
        result: "error",
        err_msg: "Record not found"
      });
    };
  } catch (err) {
    res.json({ 
      result: "error",
      err_msg: "DB error in /release: " + err
    });
  };
});


app.get("*", (req, res) => {
  res.sendFile(path.join(buildPath, 'index.html'));
});


app.listen(PORT, () => {
  console.log(`Server listening on ${PORT}`);
});
