import EE from "events";
import r from "rethinkdb";
import querystring from "querystring";
import url from "url";
import nJwt from "njwt";
import winston from "winston";
import APIError from "./api-error";
import jwt from "jsonwebtoken";
import dove from "dove-jwt";
import config from "sp-configuration";
import ms from "ms";
import aguid from "aguid";

dove.useSystemCertAuthorities();

const DOMAIN = config.require("DOMAIN");
const JWT_ISSUER = `https://${DOMAIN}/`;
const JWT_SECRET = Buffer.from(config.require("JWT_SECRET"), "base64");
const JWT_AUDIENCE = config.require("JWT_AUDIENCE");
const JWT_EXPIRATION = ms(config.require("JWT_EXPIRATION"));
// Upstream auth server that we trust, e.g. https://auth.stream.place/
const AUTH_ISSUER = config.require("AUTH_ISSUER");

// Reusable 403 token error!
const tokenErr = function() {
  return new APIError({
    status: 403,
    code: "ERR_TOKEN_INVALID",
    message: "Provided JWT is invalid"
  });
};

export default class SKContext extends EE {
  constructor({ remoteAddress, replaceToken }) {
    super();
    this.remoteAddress = remoteAddress;
    this._replaceToken = replaceToken;
    this.resources = SKContext.resources;
  }

  useToken(token) {
    return Promise.resolve().then(() => {
      // Before anything else, you need a token.
      if (!token) {
        throw new APIError({
          status: 401,
          code: "MISSING_TOKEN",
          message: "Missing authentication token"
        });
      }

      // You have a token. Let's see if it checks out in one of our ways.
      let header;
      let unsafePayload;
      try {
        const unsafeDecoded = jwt.decode(token, { complete: true });
        header = unsafeDecoded.header;
        unsafePayload = unsafeDecoded.payload;
      } catch (e) {
        winston.error("Error decoding JWT", e);
        throw tokenErr();
      }

      let payload;

      // First way -- it could be an HS256 token signed with our signing key. That's cool. That
      // means it's us, we trust it.
      if (header.alg === "HS256") {
        try {
          payload = jwt.verify(token, JWT_SECRET, { algorithms: "HS256" });
        } catch (e) {
          winston.error("Provided JWT failed verification", e);
          throw tokenErr();
        }

        // jwt looks broadly okay. Does the audience match?
        if (payload.aud !== JWT_AUDIENCE) {
          winston.error(
            `JWT aud wrong: got ${payload.aud} expected ${JWT_AUDIENCE}.`
          );
          throw tokenErr();
        }
      } else if (header.alg === "RS256" && unsafePayload.iss === AUTH_ISSUER) {
        // Second way -- it could be a dove-jwt, signed by our trusted authIssuer. Let's check.
        try {
          payload = dove.verify(token);
        } catch (e) {
          winston.error("Error verifying dove-jwt", e);
          throw tokenErr();
        }

        if (payload.aud !== `https://${DOMAIN}/`) {
          winston.error(
            `JWT aud wrong: got ${payload.aud} expected https://${DOMAIN}/.`
          );
          throw tokenErr();
        }
      } else {
        // Yuck!
        winston.error(`JWT uses unknown algorithm: ${header.alg}`);
        throw tokenErr();
      }

      this.jwt = payload;

      // jwt looks great! there are a few circumstances where we might re-issue one. it could be
      // - from an external issuer (Auth0)
      // - a dove-jwt (auth.stream.place)
      // - past halfway into its expiration time
      if (payload.iss !== JWT_ISSUER || header.alg !== "HS256") {
        this.issueNewToken(payload.sub);
      }
    });
  }

  data(tableName, oldVal, newVal) {
    if (!newVal) {
      this.emit("data", {
        tableName,
        id: oldVal.id,
        doc: null
      });
    } else {
      this.emit("data", {
        tableName,
        id: newVal.id,
        doc: newVal
      });
    }
  }

  cleanup() {
    if (this.conn) {
      this.conn.close();
    }
  }

  isService() {
    if (!this.user) {
      return false;
    }
    if (this.user.roles.indexOf("ADMIN") !== -1) {
      return true;
    }
  }

  isAdmin() {
    if (!this.user) {
      return false;
    }
    if (this.user.roles.indexOf("ADMIN") !== -1) {
      return true;
    }
  }

  isPrivileged() {
    return this.isService() || this.isAdmin();
  }

  issueNewToken(subject) {
    if (!this._replaceToken) {
      throw new Error("This context doesn't have a way to replace JWTs.");
    }
    // TODO think more about this special case... I really want this logic to be in sp-plugin-auth
    // but here we are.
    const AUTH0_HEADER = "auth0|";
    if (subject.indexOf(AUTH0_HEADER) === 0) {
      const uuidSubject = aguid(subject.slice(AUTH0_HEADER.length));
      subject = `https://${DOMAIN}/api/users/${uuidSubject}`;
    }
    const newToken = jwt.sign({}, JWT_SECRET, {
      algorithm: "HS256",
      expiresIn: `${JWT_EXPIRATION}ms`,
      audience: JWT_AUDIENCE,
      issuer: JWT_ISSUER,
      subject: subject
    });
    this.jwt = jwt.decode(newToken);
    this._replaceToken(newToken);
  }
}

SKContext.resources = {};
SKContext.addResource = function(resource) {
  if (SKContext.resources[resource.constructor.tableName]) {
    throw new Error(`Context got resource ${resource.constructor.name} twice!`);
  }
  SKContext.resources[resource.constructor.tableName] = resource;
};

/**
 * Singleton promise that ensures our database exists before we do anything else.
 */
SKContext.dbCreatePromise = null;
SKContext.ensureDbExists = function(ctx) {
  if (!SKContext.dbCreatePromise) {
    SKContext.dbCreatePromise = r
      .dbCreate(ctx.conn.db)
      .run(ctx.conn)
      .then(() => {
        winston.info(`Created database ${ctx.conn.db}`);
      })
      .catch(err => {
        // If it already exists, that's chill. Otherwise throw an error.
        if (err.name !== "ReqlOpFailedError") {
          throw err;
        }
      });
  }
  return SKContext.dbCreatePromise;
};

SKContext.createContext = function({
  rethinkHost,
  rethinkPort,
  rethinkDatabase,
  rethinkUser,
  rethinkPassword,
  rethinkCA,
  token,
  remoteAddress,
  replaceToken
}) {
  const ctx = new SKContext({ remoteAddress, replaceToken });
  return ctx
    .useToken(token)
    .then(() => {
      const params = {
        host: rethinkHost,
        port: rethinkPort,
        db: rethinkDatabase,
        user: rethinkUser || "admin",
        password: rethinkPassword || ""
      };
      if (rethinkCA) {
        params.ssl = { ca: rethinkCA };
      }
      return r.connect(params);
    })
    .then(conn => {
      ctx.rethink = r;
      ctx.conn = conn;
      return SKContext.ensureDbExists(ctx);
    })
    .then(() => {
      return ctx.resources.users.findOrCreateFromContext(ctx);
    })
    .then(user => {
      ctx.user = user;
      return ctx;
    });
};
