import BlockGasPanel from "../components/BlockGasPanel.jsx";
import LatencyPanel from "../components/LatencyPanel.jsx";
import SyncPanel from "../components/SyncPanel.jsx";
import ReorgPanel   from "../components/ReorgPanel.jsx";
import EmptyBlocksPanel from "../components/EmptyBlocksPanel.jsx";

// Monitor 大盘 — Block Gas(执行视角) / Latency / 节点同步 / Reorg / 空块,各占一整行(页面滚动)
// 利用率/流量视角在流量子系统,这里看执行吞吐与块负载
export default function MonitorPage({ state }) {
  return (
    <div className="dash-monitor-v2">
      <BlockGasPanel blockGas={state.blockGas} gasLimit={state.latestBlock?.gasLimit} />
      <LatencyPanel />
      <SyncPanel />
      <ReorgPanel data={state.reorgTimeline} />
      <EmptyBlocksPanel />
    </div>
  );
}
