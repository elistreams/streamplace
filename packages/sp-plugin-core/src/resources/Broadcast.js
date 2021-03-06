import Resource from "sp-resource";

export default class Broadcast extends Resource {
  default() {
    return super.default().then(doc => {
      return {
        ...doc,
        startTime: Date.now(),
        stopTime: null
      };
    });
  }

  auth(ctx, doc) {
    return Promise.resolve();
  }

  authQuery(ctx, query) {
    return Promise.resolve({});
  }
}
