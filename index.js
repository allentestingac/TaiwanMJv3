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
];

let temp_scores = [];
let pending_scores = [];

// Have Node serve the files for our built React app (needed for code deploy)
const __filename = fileURLToPath(import.meta.url); // get the resolved path to the file
const __dirname = path.dirname(__filename); // get the name of the directory
const buildPath = __dirname + '/build/';
app.use(express.static(buildPath));
// Have Node serve the files for our built React app (needed for code deploy)

app.use(bodyParser.urlencoded({ extended: true }));

db.connect();


/* Start of WebSocket server connection */

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

console.log(`Websocket server started...`);

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
    fetchPendingPayment(gid, pid);
    getAllPendingScores(gid, pid);
    getAllPayment(gid, pid);
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
    const gameID = parsed_data.gameID;
    const playerID = parsed_data.playerID;  

    if (action === "SUBSCRIBE") {
      subscribe(gameID, playerID, ws);
    } 
    else if (action === "UNSUBSCRIBE") {
      unsubscribe(ws);
    }
    else if (action === "PING") {
      ws.send(JSON.stringify("PONG"));
    }
    else {
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
{ "action" : "GAMELIST / SCOREBOARD / RESET_SCORES / TEMP_SCORES",   // for ALL
  "gameID" : My game ID,                                             // for ALL other than GAMELIST
  "playerID" : My player ID                                          // for ALL other than GAMELIST
  "data" : { "value": 57, "label": "57 - game name for 57" }         // for GAMELIST
           { "result": "success", "score_board": scoreboard }        // for SCOREBOARD fetch success
           { "result": "error", "err_msg": error message text }      // for SCOREBOARD fetch fail
           { "payeeID": "1", "payeeName": "name", "payment": 100 }   // for PAYMENT_REQUEST
           { "card_ID": 1 / 2 / 3 }                                  // for RESET_SCORES
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
  } 
  else if (channels[game_id]) {
    const arrItem = channels[game_id];
    if (xact_code === "SCOREBOARD") {  
      arrItem.forEach((item) => {
        const message = {
          "action": xact_code,
          "gameID": game_id,
          "playerID": Number(item.playerID),
          "data": data_content
        };
        item.ws.send(JSON.stringify(message));
      });
    }
    else if (xact_code === "REQUEST_PAYMENT" || xact_code === "ACCEPT_PAYMENT" || 
             xact_code === "REJECT_PAYMENT" || xact_code === "PENDING_PAYMENT" ||
             xact_code === "PENDING_SCORES") {
      arrItem.forEach((item) => {
        if (item.playerID === player_id) {
          const message = {
            "action": xact_code,
            "gameID": game_id,
            "playerID": Number(player_id),
            "data": data_content
          };
          item.ws.send(JSON.stringify(message));
        };
      });
    } 
    else {
      console.log("Unknown ws server message xact_code " + xact_code);
    };
  };
};


async function sendRequestPaymentMsg(gid, pid, ts, tid, tname, fid, fname, total, half) {
  const score = await getPlayerScore(gid, tid);  
  const payment = {
    "ts": ts,
    "payeeID": tid,
    "payeeName": tname,
    "payeeScore": score,
    "payerID": fid,
    "payerName": fname,
    "total": total,
    "isHalf": half
  };
  sendServerMessage(gid, pid, "REQUEST_PAYMENT", payment);
};


async function fetchPendingPayment(gid, pid) {
  try {
    const db_result = await db.query(
      "SELECT * FROM payment WHERE gid = $1 AND fid = $2 AND status = $3 ORDER BY ts ASC",
      [Number(gid), Number(pid), "P"]
    );
    if (db_result.rowCount > 0) {
      const result = db_result.rows;
      result.forEach( item => {
        sendRequestPaymentMsg(gid, pid, item.ts, item.tid, item.tname, item.fid, item.fname, item.total, item.half);
      });
    } else {
      console.log("No pending payment request for game " + gid + " player " + pid);
    };
  } catch (err) {
    console.log("DB error in /fetchPendingPayment");
  };
};


/* End of WebSocket server connection */


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
    };
  } catch (err) {
    return {
      result: "error",
      err_msg: "DB error in /fetchScoreBoard: " + err
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


async function getAllPayment(gid, pid) {
  let id = 0;
  let data = {};
  for (id=0; id<3; id++) {
    data = await getPayment(gid, pid, id);
    if (data.result !== "success") {
      console.log(data.err_msg);
    }
  };
};


async function getPayment(gid, pid, cid) {
  try {
    const db_result = await db.query(
      "SELECT * FROM payment WHERE gid = $1 AND tid = $2 AND cid = $3 AND (status = $4 OR status = $5 OR status = $6) ORDER BY ts ASC",
      [Number(gid), Number(pid), Number(cid), "A", "R", "P"]
    );
    if (db_result.rowCount > 0) {
      const result = db_result.rows;
      result.forEach( item => {  
        const data = {
          "gameID": item.gid,
          "ts": item.ts,
          "payerID": item.fid,
          "payeeID": item.tid,
          "cardID": item.cid,
          "isHalf": item.half
        };
        sendServerMessage(
          gid, 
          pid, 
          ( item.status === "A" ? "ACCEPT_PAYMENT" : 
            item.status === "R" ? "REJECT_PAYMENT" :
            "PENDING_PAYMENT"), 
          data
        );
      });
      return { 
        result: "success"
      };
    } else {
      console.log("No pending advised payment for game " + gid + " player " + pid + " card " + cid);
      return {
        result: "success"
      };
    };
  } catch (err) {
    return {
      result: "error",
      err_msg: "DB error in /advisedPayment: " + err
    };
  };
};



app.get("/checkpayment", async (req, res) => {
  const gameID = req.query.gameID;
  const playerID = req.query.playerID;
  const cardID = req.query.cardID;
  const result = await getPayment(gameID, playerID, cardID);
  res.json(result);
});


function getAllPendingScores(gid, myID) {
  let id = 0;
  for (id=1; id<5; id++) {
    if (Number(id) !== Number(myID)) {
      const result = getPendingScores(gid, myID, id);
      const msg = {
        "fromPID": id.toString(),
        "count": result.count,
        "total": result.total
      };
      console.log(gid, myID, msg);
      sendServerMessage(gid, myID, "PENDING_SCORES", msg);
    };
  };
};


function getPendingScores(gid, myID, toID) {
  const score = pending_scores.find( score => 
    Number(score.gameID) === Number(gid) && Number(score.toPID) === Number(myID) && Number(score.fromPID) === Number(toID)
  );
  if (score !== undefined) {
    return {
      "result": "success",
      "count": score.count,
      "total": score.total
    };
  } else {
    return {
      "result": "success",
      "count": 0,
      "total": 0
    };
  };
};


app.get("/checkpendingscores", async (req, res) => {
  const gameID = req.query.gameID;
  const myPID = req.query.myPID;
  const toPID = req.query.toPID;
  const result = getPendingScores(gameID, myPID, toPID);
  res.json(result);
/*  
  const score = pending_scores.find( score => 
    Number(score.gameID) === Number(gameID) && Number(score.toPID) === Number(myPID) && Number(score.fromPID) === Number(toPID)
  );
  if (score !== undefined) {
    res.json({ 
      result: "success",
      count: score.count,
      total: score.total
    });
  } else {
    res.json({ 
      result: "success",
      count: 0,
      total: 0
    });
  };*/
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


async function getPlayerScore(gid, pid) {
  try {
    const db_result = await db.query(
      "SELECT score FROM scoreboard WHERE gid = $1 AND pid = $2", [Number(gid), Number(pid)]
    );
    if (db_result.rowCount > 0) {
      return db_result.rows[0].score;
    } else {
      return 0;
    }
  } catch (err) {
    console.log("DB error in /getPlayerScore: " + err);
  };
};


app.post("/requestpayment", async (req, res) => {
  const ts = Date.now();
  const cDateTme = new Date(ts).toLocaleDateString() + " " + new Date(ts).toLocaleTimeString();
  const gameID = req.query.gameID;
  const score = await getPlayerScore(gameID, req.query.payeeID);
  const isHalf = req.query.isHalf;
  const payment = {
    "ts": ts,
    "payeeID": req.query.payeeID,
    "payeeName": req.query.payeeName,
    "payeeScore": score,
    "payerID": req.query.payerID,
    "payerName": req.query.payerName,
    "total": req.query.total,
    "isHalf": isHalf
  };
  const cardID = req.query.cardID;
  const scores = `{${req.query.scores.map(item => Number(`${item}`)).join(',')}}`;
  const status = "P";
  const type = req.query.type;

  try {
    const db_insert_result = await db.query(
      "INSERT INTO payment (gid, ts, datetime, type, fid, fname, tid, tname, cid, total, scores, half, status) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)",
      [Number(gameID), payment.ts, cDateTme, type, Number(payment.payerID), payment.payerName, Number(payment.payeeID), payment.payeeName, Number(cardID), Number(payment.total), scores, isHalf, status]
    );
    if (db_insert_result.rowCount === 1) {
      res.json({ 
        result: "success",
        ts: ts
      });
      sendServerMessage(gameID, payment.payerID, "REQUEST_PAYMENT", payment);
    } else {
      res.json({ 
        result: "error",
        err_msg: "Record not updated"
      });
    };
  } catch (err) {
    res.json({ 
      result: "error",
      err_msg: "DB error in /requestpayment: " + err
    });
  };
});


app.post("/acceptpayment", async (req, res) => {
  const gameID = req.query.gameID;
  const ts = req.query.ts;
  const payerID = req.query.payerID;
  const payeeID = req.query.payeeID;
  const points = req.query.payment;
  try {
    await db.query("BEGIN");
    const db_select_result = await db.query(
      "SELECT * FROM payment WHERE gid = $1 AND ts = $2 AND fid = $3 AND tid = $4 AND status = $5",
      [Number(gameID), ts, Number(payerID), Number(payeeID), "P"]
    );
    if (db_select_result.rowCount === 1) {
      const db_update_result1 = await db.query(
        "UPDATE payment SET status = $1 WHERE gid = $2 AND ts = $3 AND fid = $4 AND tid = $5",
        ["A", Number(gameID), ts, Number(payerID), Number(payeeID)]
      );
      const db_update_result2 = await db.query(
        "UPDATE scoreboard SET score = score - $1 WHERE gid = $2 AND pid = $3",[Number(points), Number(gameID), Number(payerID)]
      );
      const db_update_result3 = await db.query(
        "UPDATE scoreboard SET score = score + $1 WHERE gid = $2 AND pid = $3",[Number(points), Number(gameID), Number(payeeID)]
      );
      const db_insert_result1 = await db.query(
        "INSERT INTO activity (gid, ts, datetime, type, fid, fname, tid, tname, score) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
        [gameID, ts, db_select_result.rows[0].datetime, db_select_result.rows[0].type, Number(payerID), db_select_result.rows[0].fname, Number(payeeID), db_select_result.rows[0].tname, Number(points)]
      );
      if (db_update_result1.rowCount === 1 && db_update_result2.rowCount === 1 && db_update_result3.rowCount === 1 && db_insert_result1) {
        await db.query("COMMIT");
        res.json({ result: "success"});
        const fetch_result = await fetchScoreBoard(gameID);
        sendServerMessage(gameID, payeeID, "SCOREBOARD", fetch_result);
        const data = {
          "gameID": gameID,
          "ts": ts,
          "payerID": payerID,
          "payeeID": payeeID,
          "cardID": db_select_result.rows[0].cid
        };
        sendServerMessage(gameID, payeeID, "ACCEPT_PAYMENT", data);
      } else {
        await db.query("ROLLBACK");
        res.json({ 
          result: "error",
          err_msg: "DB error in /acceptpayment: " + err
        });
      };
    } else {
      await db.query("ROLLBACK");
      res.json({ 
        result: "error",
        err_msg: "Pending payment not found in /acceptpayment"
      });
    };
  } catch (err) {
    await db.query("ROLLBACK");
    res.json({ 
      result: "error",
      err_msg: "DB error in /acceptpayment: " + err
    });
  };
});


app.post("/rejectpayment", async (req, res) => {
  const gameID = req.query.gameID;
  const ts = req.query.ts;
  const payerID = req.query.payerID;
  const payeeID = req.query.payeeID;
  try {
    const db_update_result = await db.query(
      "UPDATE payment SET status = $1 WHERE gid = $2 AND ts = $3 AND fid = $4 AND tid = $5 AND status = $6 RETURNING cid",
      ["R", Number(gameID), ts, Number(payerID), Number(payeeID), "P"]
    );
    if (db_update_result.rowCount === 1) {
      res.json({ result: "success"});
      const data = {
        "gameID": gameID,
        "ts": ts,
        "payerID": payerID,
        "payeeID": payeeID,
        "cardID": db_update_result.rows[0].cid
      };
      sendServerMessage(gameID, payeeID, "REJECT_PAYMENT", data);
    } else {
      res.json({ 
        result: "error",
        err_msg: "Pending payment not found in /rejectpayment"
      });
    };
  } catch (err) {
    res.json({ 
      result: "error",
      err_msg: "DB error in /rejectpayment: " + err
    });
  };
});


app.post("/completepayment", async (req, res) => {
  const gameID = req.query.gameID;
  const ts = req.query.ts;
  const payerID = req.query.payerID;
  const payeeID = req.query.payeeID;
  const status = req.query.status;
  try {
    const db_update_result = await db.query(
      "UPDATE payment SET status = $1 WHERE gid = $2 AND ts = $3 AND fid = $4 AND tid = $5",
      [status, Number(gameID), ts, Number(payerID), Number(payeeID)]
    );
    if (db_update_result.rowCount === 1) {
      res.json({ result: "success"});
      if (status === "CA") {
        const newCount = 0;
        const newTotal = 0;
        updatePendingScores(gameID, payeeID, payerID, newCount, newTotal);
        const msg = {
          "fromPID": payeeID,
          "count": newCount,
          "total": newTotal
        };
        sendServerMessage(gameID, payerID, "PENDING_SCORES", msg);
      };
    } else {
      res.json({ 
        result: "error",
        err_msg: "Record not updated"
      });
    };
  } catch (err) {
    res.json({ 
      result: "error",
      err_msg: "DB error in /completepayment: " + err
    });
  };
});


function updatePendingScores(gid, fid, tid, cnt, tot) {
  const index = pending_scores.findIndex( score => score.gameID === gid && score.fromPID === fid && score.toPID === tid);
  if (index !== -1) {
    pending_scores[index].count = cnt;
    pending_scores[index].total = tot;
  } else {
    const new_score = {
      "gameID": gid,
      "fromPID": fid,
      "toPID": tid,
      "count": cnt,
      "total": tot
    };
    pending_scores.push(new_score);
  };
  console.log(pending_scores);
};


app.post("/pendingscores", async (req, res) => {
  const gameID = req.query.gameID;
  const fromPlayerID = req.query.fromPID;
  const toPlayerID = req.query.toPID;
  const count = Number(req.query.count);
  const total = Number(req.query.total);
  const msg = {
    "fromPID": fromPlayerID,
    "count": count,
    "total": total
  };
  updatePendingScores(gameID, fromPlayerID, toPlayerID, count, total);
  sendServerMessage(gameID, toPlayerID, "PENDING_SCORES", msg);
  res.json({
    result: "success"
  });
});


app.post("/register", async (req, res) => {
  const gameID = Number(req.query.gameID);
  const playerID = Number(req.query.playerID);
  const name_to_register = req.query.name;
  try {
    const db_select_result = await db.query(
      "SELECT name, joined FROM scoreboard WHERE gid = $1 AND pid = $2",
      [gameID, playerID]
    );
    if (db_select_result.rowCount === 1) {
      const player_name = db_select_result.rows[0].name;
      const player_joined = db_select_result.rows[0].joined;
      if (player_joined === false) {
        try {
          const db_update_result = await db.query(
            "UPDATE scoreboard SET name = $1, joined = $2 WHERE gid = $3 AND pid = $4",
            [name_to_register, true, gameID, playerID]
          );
          if (db_update_result.rowCount === 1) {
            const scores = getTempScores(gameID, playerID);
            res.json({ 
              result: "success",
              scores: scores
            });
            const fetch_result = await fetchScoreBoard(gameID);
            sendServerMessage(gameID, playerID, "SCOREBOARD", fetch_result);
          } else {
            res.json({ 
              result: "error",
              err_msg: "DB error in /register: record not updated"
            });
          };
/*          fetchPendingPayment(gameID, playerID);*/
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


function getTempScores(gid, pid) {
  const score = temp_scores.find( score => 
    Number(score.gameID) === Number(gid) && Number(score.playerID) === Number(pid)
  );
  if (score !== undefined) {
    return score;
  } else {
    return {};
  };
};


function updateTempScores(gid, pid, new_scores) {
  new_scores.gameID = gid;
  new_scores.playerID = pid;
  if (new_scores.timeStamp0) {
    new_scores.timeStamp0 = Number(new_scores.timeStamp0)
  };
  if (new_scores.timeStamp1) {
    new_scores.timeStamp1 = Number(new_scores.timeStamp1)
  };  
  if (new_scores.timeStamp2) {
    new_scores.timeStamp2 = Number(new_scores.timeStamp2)
  }; 
  if (new_scores.isHalf0) {
    new_scores.isHalf0 = JSON.parse(new_scores.isHalf0);
  };
  if (new_scores.isHalf1) {
    new_scores.isHalf1 = JSON.parse(new_scores.isHalf1);
  };
  if (new_scores.isHalf2) {
    new_scores.isHalf2 = JSON.parse(new_scores.isHalf2);
  }; 
  if (new_scores.itemList0) {
    new_scores.itemList0 = new_scores.itemList0.map( item => (item == '') ? '' : Number(item));
  };
  if (new_scores.itemList1) {
    new_scores.itemList1 = new_scores.itemList1.map( item => (item == '') ? '' : Number(item));
  };
  if (new_scores.itemList2) {
    new_scores.itemList2 = new_scores.itemList2.map( item => (item == '') ? '' : Number(item));
  };
  const index = temp_scores.findIndex( score => 
    score.gameID === gid && score.playerID === pid
  );
  if (index !== -1) {
    temp_scores.splice(index, 1);
  };
  temp_scores.push(new_scores);
  console.log(temp_scores);
};


app.post("/release", async (req, res) => {
  const gameID = Number(req.query.gameID);
  const playerID = Number(req.query.playerID);
  const scores = req.query.scores;
  try {
    const db_update_result = await db.query(
      "UPDATE scoreboard SET joined = $1 WHERE gid = $2 AND pid = $3",
      [false, gameID, playerID]
    );

    if (db_update_result.rowCount === 1) {
      res.json({ result: "success" });
      const fetch_result = await fetchScoreBoard(gameID);
      sendServerMessage(gameID, playerID, "SCOREBOARD", fetch_result);
      updateTempScores(gameID, playerID, scores);
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


server.listen(PORT, () => {
  console.log(`HTTP server listening on ${PORT}`);
}).on('error', (err) => {
  console.log(err);
});
