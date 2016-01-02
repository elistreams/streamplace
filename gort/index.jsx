
import ReactDOM from 'react-dom';
import { Router, Route, Link } from 'react-router';

import BroadcastIndex from './components/broadcasts/BroadcastIndex';
import BroadcastDetail from './components/broadcasts/BroadcastDetail';
import NotFound from './components/NotFound';

import {} from "./components/main.scss";
import {} from "font-awesome-webpack";
import {} from "twixtykit/base.scss";

ReactDOM.render((
  <Router>
    <Route path="/" component={BroadcastIndex} />
    <Route path="/broadcasts/:broadcastId" component={BroadcastDetail} />
    <Route path="*" component={NotFound} />
  </Router>
), document.querySelector('main'));