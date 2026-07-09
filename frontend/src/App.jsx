import { useState } from "react";
import { useMonitor }  from "./hooks/useMonitor.js";
import Topbar       from "./components/Topbar.jsx";
import NavRail      from "./components/NavRail.jsx";
import HomePage     from "./pages/HomePage.jsx";
import MonitorPage  from "./pages/MonitorPage.jsx";
import MevPage      from "./pages/MevPage.jsx";
import TrafficPage  from "./pages/TrafficPage.jsx";
import StoragePage  from "./pages/StoragePage.jsx";
import TxnPage      from "./pages/TxnPage.jsx";
import AlertsPage   from "./pages/AlertsPage.jsx";
import "./App.css";

export default function App() {
  const state = useMonitor();
  const [page, setPage] = useState("home");

  return (
    <div className="app-shell">
      <NavRail current={page} onNav={setPage} connected={state.connected} />

      <div className="app-content">
        <Topbar
          latestBlock={state.latestBlock}
          windowStats={state.windowStats}
          mevStats={state.mevStats}
          connected={state.connected}
          page={page}
        />

        {page === "home"    && <HomePage state={state} onNav={setPage} />}
        {page === "monitor" && <MonitorPage state={state} />}
        {page === "mev"     && <MevPage state={state} />}
        {page === "traffic" && <TrafficPage state={state} />}
        {page === "storage" && <StoragePage />}
        {page === "txn"     && <TxnPage />}
        {page === "alerts"  && (
          <AlertsPage
            slashStatus={state.slashStatus}
            recentBlocks={state.recentBlocks}
          />
        )}
      </div>
    </div>
  );
}
