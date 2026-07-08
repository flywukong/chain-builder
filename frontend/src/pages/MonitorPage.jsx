import BlockGasPanel from "../components/BlockGasPanel.jsx";
import LatencyPanel from "../components/LatencyPanel.jsx";
import ReorgPanel   from "../components/ReorgPanel.jsx";

// Monitor 大盘 — Block Gas(执行视角) / Latency / Reorg 分析
// 利用率/流量视角在流量子系统,这里看执行吞吐与块负载
export default function MonitorPage({ state }) {
  return (
    <div className="dash dash-monitor">
      <div className="panel-row panel-row-2">
        <BlockGasPanel blockGas={state.blockGas} />
        <LatencyPanel />
      </div>
      <ReorgPanel data={state.reorgTimeline} />
    </div>
  );
}
