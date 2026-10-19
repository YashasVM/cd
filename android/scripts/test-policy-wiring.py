#!/usr/bin/env python3
"""Static wiring regressions for paths that require Android at runtime.

Complements JVM policy tests; does not simulate Android service/network behavior.
"""
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1] / 'app/src/main/java/in/yash0/cd'


class PolicyWiringTest(unittest.TestCase):
    def test_fresh_pair_starts_receiver_without_previously_enabled_flag(self):
        activity = (ROOT / 'MainActivity.kt').read_text()
        trust = activity.split('override fun trust(pair: Pairing)', 1)[1].split('override fun revoke', 1)[0]
        self.assertIn('ReceiveMode.onForeground(this)', trust)
        mode = (ROOT / 'ui/ReceiveModeStub.kt').read_text()
        foreground = mode.split('fun onForeground(context: Context)', 1)[1].split('fun onBackground', 1)[0]
        self.assertIn('startTransfer(context)', foreground)
        self.assertNotIn('.enabled()', foreground)
        self.assertIn('ReceiveActivation.shouldStart(_paused.value', foreground)
        service = (ROOT / 'ReceiverService.kt').read_text()
        self.assertIn('ReceiveMode.recordPaused(this, true)', service)
        self.assertIn('if (stopping.get()) { running.set(false); stopSelf() }', service)
        unpause = mode.split('fun setPaused(context: Context, paused: Boolean)', 1)[1].split('fun startTransfer', 1)[0]
        self.assertIn('onForeground(context)', unpause)

    def test_sender_uses_bound_client_and_rechecks_active_network(self):
        sender = (ROOT / 'SendEngineImpl.kt').read_text()
        self.assertIn('network.bind(client, invitation.relay)', sender)
        self.assertNotRegex(sender, r'Wire\(client,\s*invitation.relay')
        self.assertIn('network.allowed(invitation.relay)', sender)
        self.assertIn('run.checkNetwork', sender)
        self.assertIn('SendNetworkGuard(binding.allowed)', sender)
        self.assertIn('Wire(binding.client, invitation.relay)', sender)
        self.assertIn('boundGuard.check(); ws.send(join.toString())', sender)
        self.assertIn('wire.abort(e)', sender)
        network = (ROOT / 'ReceiverNetwork.kt').read_text()
        self.assertIn('socketFactory(network.socketFactory)', network)
        self.assertIn('network.getAllByName(hostname)', network)
        self.assertIn('Binding(bound) { publicAllowed(network) }', network)
        activity = (ROOT / 'MainActivity.kt').read_text()
        self.assertIn('TransferBus.sender.networkPolicyChanged()', activity)


if __name__ == '__main__':
    unittest.main()
