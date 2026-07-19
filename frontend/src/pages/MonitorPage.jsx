import BlockGasPanel from "../components/BlockGasPanel.jsx";
import LatencyPanel from "../components/LatencyPanel.jsx";
import SyncPanel from "../components/SyncPanel.jsx";
import ReorgPanel   from "../components/ReorgPanel.jsx";
import SlashPanel from "../components/SlashPanel.jsx";
import EmptyBlocksPanel from "../components/EmptyBlocksPanel.jsx";

// Monitor 大盘 — Block Gas(执行视角) / Reorg / Slash / Latency / 空块 / 节点同步,各占一整行(页面滚动)
// 利用率/流量视角在流量子系统,这里看执行吞吐与块负载
export default function MonitorPage({ state }) {
  return (
    <div className="dash-monitor-v2">
      <BlockGasPanel blockGas={state.blockGas} gasLimit={state.latestBlock?.gasLimit} />
      <ReorgPanel data={state.reorgTimeline} />
      <SlashPanel />
      <LatencyPanel />
      <EmptyBlocksPanel />
      <SyncPanel />
    </div>
  );
}
