module.exports = function(app, cf) {
    var https = require('https');

    var getUri = function(path) {
        return app.siteConf.uri + path;
    }

    var defaultStream = "general";

    // Setup the Asms DB and User Schema and Auth
    var defaultAvatar = getUri('/img/codercat-sm.jpg');

    var actorTypes = ['Person', 'Group', 'Application', 'Service'];
    var objectTypes = ['Photo', 'Application', 'Instance', 'Article', 'Person', 'Place', 'Service', 'Comment'];
    var verbs = ['Post', 'Favorite', 'Follow', 'Join', 'Like', 'Friend', 'Play', 'Save', 'Share', 'Tag', 'Create', 'Update', 'Read', 'Delete', 'Check In', 'Like'];

    var githubHash = {objectType: 'Service', displayName: 'GitHub', url: 'http://github.com', icon : {url: 'http://github.com/favicon.ico'}};
    var weiboHash = {objectType: 'Service', displayName: 'Weibo', url: 'http://weibo.com', icon : {url: 'http://weibo.com/favicon.ico'}};

    var streamLib = require('activity-streams-mongoose')({
        mongoUrl: app.siteConf.mongoUrl,
        redis: app.siteConf.redisOptions,
        defaultActor: defaultAvatar
    });

    var authentication = new require('./authentication.js')(streamLib, app.siteConf);

    // Moved normalization to only be done on pre save
    streamLib.types.UserSchema.pre('save', function (next) {
        var user = this;
        var svcUrl = null;
        if (user.wb && user.wb.id) {
            user.displayName = user.wb.name.full;
            user.accessToken = user.wb.accessToken;
            asmsDB.ActivityObject.findOne().where('url', weiboHash.url).exec(function(err, doc){
                if (err) throw err;
                user.author = doc._id;
				//TO DO Get User Image
                // Need to fetch the users image...
                // https.get({
                //     'host': 'weibo.com'
                //     , 'path': '/me/picture?access_token='+ user.wb.accessToken
                // }, function(response) {
                //     user.image = {url: response.headers.location};
                //     next();
                // }).on('error', function(e) {
                //     next();
                // });
            })
        } else  {
            if (user.github && user.github.id) {
                user.displayName = user.github.name;
                user.accessToken = user.github.plan.name; // temp holder because I dont feel like forking the mongoose-auth repo right now
                var avatar = 'http://1.gravatar.com/avatar/'+ user.github.gravatarId + '?s=48'
                user.image = {url: avatar};
                svcUrl = githubHash.url;
            } 

            user.objectType = "person";
            user.url = app.siteConf.uri + "/users/" + user._id;

            if(!user.actor) {
                asmsDB.ActivityObject.findOne().where('url', svcUrl).exec(function(err, doc){
                    user.author = doc;
                    next();
                });
            } else {
                next();
            }
        }
      });

    var asmsDB = new streamLib.DB(streamLib.db, streamLib.types);
    streamLib.asmsDB = asmsDB;

    // Setup default Objects
    // TODO: Change to find or create by
    var thisInstance = {objectType : "instance"};
    if (cf.app) {
        thisInstance.image = {url: getUri('/img/cf-process.jpg')};
        thisInstance.url = "http://" + cf.host + ":" + cf.port;
        thisInstance.displayName = "App Instance " + cf.app['instance_index'];
        thisInstance.content = cf.app['instance_id']
    } else {
        thisInstance.displayName =  "Instance 0 -- Local";
    }

    var appOwner = {displayName: app.siteConf.user.name, objectType: 'person', url: app.siteConf.user.website, image:{url: getUri("http://tp3.sinaimg.cn/2214553562/180/5646550610/2")}};

    var thisApp = new asmsDB.ActivityObject({
        objectType: 'Application',
        displayName: 'Activity Streams App',
        url: app.siteConf.uri,
        image:{url: getUri('/img/as-logo-sm.png')}
    });

    thisApp.save(function (err) {
        if (err) throw err;
    });

    var thisProvider = new asmsDB.ActivityObject({
        objectType: 'Service',
        'displayName': 'Cloud Foundry',
        icon:{url: 'http://www.cloudfoundry.com/images/favicon.ico'}
    });
    thisProvider.save(function(err){if (err) throw err});

    var github = new asmsDB.ActivityObject(githubHash);
    github.save(function(err){if (err) throw err});
    var weibo = new asmsDB.ActivityObject(weiboHash);
    weibo.save(function(err){if (err) throw err});

    var getCurrentUserObject = function(session) {
        if (session.user) {
            if (session.user.toSafeObject) {
               return session.user.toSafeObject();
            } else
                return session.user;
        } else if(session.uid) {
            var currentUser = {};
            currentUser.displayName = session.uid;
            currentUser.image = { url: defaultAvatar};
            return currentUser;
        }
        return null;
    }

    var publishActivity = function(desiredStream, currentUser, actHash) {

        if (!currentUser) throw("Cannot publish activity without an actor");
        if (actHash && actHash.object && actHash.object.objectType && actHash.verb) {
            actHash.actor = currentUser;

            if (!actHash.title) {
                var pastTense = actHash.verb;
                if (pastTense.substr(pastTense.length -1) === "e")
                    pastTense += "d";
                else
                    pastTense += "ed";
                actHash.title = pastTense + " a new " + actHash.object.objectType;
            }

            var act = new asmsDB.Activity(actHash);
            // Send back the message to the users room.
            act.publish(desiredStream);
        } else {
            console.log("Missing required parameters");
            console.log(actHash);
            throw(new Error("Missing required parameters"));
        }
    };

    var getDistinct = function (req, res, next, term, init){
        var key = 'used.' + term;
        req[key] = init ? init : [];
        asmsDB.Activity.distinct(term, {streams: req.session.desiredStream}, function(err, docs) {
            if (!err && docs) {
                _.each(docs, function(result){
                    req[key].push(result);
                });
                next();
            } else {
                next(new Error('Failed to fetch distinct ' + term));
            }
        });
    }

    return {
        helpers: {
            getUri: getUri,
            getCurrentUserObject : getCurrentUserObject,
            publishActivity : publishActivity,
            getDistinct : getDistinct
        },
        default :{
            owner: appOwner,
            provider : thisProvider,
            app: thisApp,
            instance: thisInstance,
            avatar: defaultAvatar,
            stream : defaultStream
        },
        users : {
            providers :{
                weibo: weibo,
                github : github
            }
        },
        streamLib : streamLib,
        asmsDB: asmsDB,
        authentication : authentication,
        metadata: {
            actorTypes: actorTypes,
            objectTypes: objectTypes,
            verbs: verbs
        }
    }
};
