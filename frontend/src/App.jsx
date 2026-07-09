import { useEffect, useState } from "react";
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

// fit-to-screen 基准画布:布局按此尺寸设计,任何视口按 min(宽比,高比) 连续缩放铺满,
// 比例在所有屏上一致(无断点)。1440×780 ≈ 笔记本上现在的观感。
const BASE_W = 1440, BASE_H = 780;

export default function App() {
  const state = useMonitor();
  const [page, setPage] = useState("home");
  // 个人大小偏好(A−/A+,存本机),乘在 fit 缩放之上
  const [zoomPref, setZoomPref] = useState(() => {
    const v = parseFloat(localStorage.getItem("uiZoomPref"));
    return v >= 0.7 && v <= 1.5 ? v : 1;
  });

  useEffect(() => {
    localStorage.setItem("uiZoomPref", String(zoomPref));
    const fit = () => {
      const s = Math.min(window.innerWidth / BASE_W, window.innerHeight / BASE_H);
      const z = Math.min(2.6, Math.max(0.7, Math.min(2.2, Math.max(0.75, s)) * zoomPref));
      document.documentElement.style.setProperty("--ui-zoom", z.toFixed(4));
    };
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [zoomPref]);

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
          zoomPref={zoomPref}
          onZoomPref={setZoomPref}
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
