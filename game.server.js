/*  Copyright (c) 2012 Sven "FuzzYspo0N" Bergström, 2013 Robert XD Hawkins
    
    written by : http://underscorediscovery.com
    written for : http://buildnewgames.com/real-time-multiplayer/
    
    modified for collective behavior experiments on Amazon Mechanical Turk

    MIT Licensed.
*/

    var
        use_db      = false,
        game_server = module.exports = { games : {}, game_count:0 },
        UUID        = require('node-uuid'),
        fs          = require('fs');

    if (use_db) {
	    database    = require(__dirname + "/database"),
	    connection  = database.getConnection();
    }

global.window = global.document = global;

require('./game.core.js');

// This is the function where the server parses and acts on messages
// sent from 'clients' aka the browsers of people playing the
// game. For example, if someone clicks on the map, they send a packet
// to the server (check the client_on_click function in game.client.js)
// with the coordinates of the click, which this function reads and
// applies.
game_server.server_onMessage = function(client,message) {
    //Cut the message up into sub components
    var message_parts = message.split('.');

    //The first is always the type of message
    var message_type = message_parts[0];

    //Extract important variables
    if (client.game.player_host.userid == client.userid) {
        var other_client = client.game.player_client;
        var change_target = client.game.gamecore.players.self;
    } else {
        var other_client = client.game.player_host;
        var change_target = client.game.gamecore.players.other;
    }

    if(message_type == 'c') {    // Client clicked somewhere
        if(!change_target.targets_enabled) {
            change_target.speed = client.game.gamecore.global_speed;
        } else {
            if(client.game.gamecore.good2write) {
                change_target.speed = client.game.gamecore.global_speed;
            }
        }
        // Set their (server) angle 
        change_target.angle = message_parts[1];

        // Set their (server) destination to the point that was clicked
        change_target.destination = {x : message_parts[2], y : message_parts[3]};
        
        // Notify other client of angle change
        if(other_client){
            other_client.send('s.a.' + message_parts[1]);
        }
    } else if (message_type == "h") { // Receive message when browser focus shifts
        change_target.visible = message_parts[1];
    }
    // else if(...) {
    
    // Any other ways you want players to interact with the game can be added
    // here as "else if" statements.
};

/* 
   The following functions should not need to be modified for most purposes
*/

game_server.createGame = function(player) {
    var id = UUID();
    //Create a new game instance
    var thegame = {
        id : id,                    //generate a new id for the game
        player_host:player,         //so we know who initiated the game
        player_client:null,         //nobody else joined yet, since its new
        player_count:1              //for simple checking of state
    };

    //Store it in the list of game
    this.games[ thegame.id ] = thegame;

    //Keep track of how many there are total
    this.game_count++;
    
    //Create a new game core instance (defined in game.core.js)
    thegame.gamecore = new game_core(thegame);

    // Tell the game about its own id
    thegame.gamecore.game_id = id;

    // Set up the filesystem variable we'll use to write later
    thegame.gamecore.fs = fs;

    // When workers are directed to the page, they specify which
    // version of the task they're running. 
    thegame.gamecore.condition = player.condition;

    // Pass the database connection to the game
    if (use_db) {
        thegame.gamecore.mysql_conn = connection;
	    thegame.gamecore.use_db = use_db;
    }

    //Start updating the game loop on the server
    thegame.gamecore.update();

    //tell the player that they are now the host
    //The client will parse this message in the "client_onMessage" function
    // in client.js, which redirects to other functions based on the command
    player.send('s.h.')
    player.game = thegame;

    // Start 'em moving
    thegame.gamecore.players.self.speed = thegame.gamecore.global_speed;
    this.log('player ' + player.userid + ' created a game with id ' + player.game.id);

    //return it
    return thegame;

}; //game_server.createGame

// we are requesting to kill a game in progress.
// This gets called if someone disconnects
game_server.endGame = function(gameid, userid) {
    var thegame = this.games[gameid];
    if(thegame) {
        //stop the game updates immediately
        thegame.gamecore.stop_update();

        //if the game has two players, then one is leaving
        if(thegame.player_count > 1) {

            //send the players the message the game is ending
            if(userid == thegame.player_host.userid) {
                //the host left, oh snap. Let's update the database and tell them.
                if(thegame.player_client) {
                    //tell them the game is over, and redirect to exit survey
                    thegame.player_client.send('s.e');
                }
            } else {
                //the other player left, we were hosting
                if(thegame.player_host) {
                    //tell the client the game is ended
                    thegame.player_host.send('s.e');
                    //i am no longer hosting, this game is going down
                    thegame.player_host.hosting = false;
                }
            }
        }
        delete this.games[gameid];
        this.game_count--;
        this.log('game removed. there are now ' + this.game_count + ' games' );
    } else {
        this.log('that game was not found!');
    }    
}; 

// When second person joins the game, this gets called
game_server.startGame = function(game) {
    
    // Tell host so that their title will flash if not visible
    game.player_host.send('s.b');

    //s=server message, j=you are joining, send player the host id
    game.player_client.send('s.j.' + game.player_host.userid);
    game.player_client.game = game;
    
    //now we tell the server that the game is ready to start
    game.gamecore.server_newgame();    

    //set this flag, so that the update loop can run it.
    game.active = true;

};

// This is the important function that pairs people up into 'rooms'
// all independent of one another.
game_server.findGame = function(player) {
    this.log('looking for a game. We have : ' + this.game_count);

    //if there are any games created, check if one needs another player
    if(this.game_count) {
        var joined_a_game = false;
        //Check through the list of all games for an open game
        for(var gameid in this.games) {
            //only care about our own properties.
            if(!this.games.hasOwnProperty(gameid)) continue;
            //get the game we are checking against
            var game_instance = this.games[gameid];
            //If the game is a player short
            if(game_instance.player_count < 2) {                
                joined_a_game = true;
                //increase the player count and store
                //the player as the client of this game
                game_instance.player_client = player;
                game_instance.gamecore.players.other.instance = player;
                game_instance.gamecore.players.other.id = player.userid;
                game_instance.player_count++;
                // start the server update loop
                game_instance.gamecore.update();
                this.startGame(game_instance);                
            }
        }
        if(!joined_a_game) { // if we didn't join a game, we must create one
            this.createGame(player);
        } 
    } else { 
        //no games? create one!
        this.createGame(player);
    }
}; 

//A simple wrapper for logging so we can toggle it,
//and augment it for clarity.
game_server.log = function() {
    console.log.apply(this,arguments);
};
