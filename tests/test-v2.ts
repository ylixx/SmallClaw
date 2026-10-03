/**
 * Simple test for LocalClaw v2 gateway
 */

async function runTest() {
  const baseUrl = 'http://127.0.0.1:18789';
  
  console.log('Testing LocalClaw v2 Gateway...\n');
  
  // Test 1: Health check
  console.log('1. Testing health check...');
  try {
    const statusRes = await fetch(`${baseUrl}/api/status`);
    const status = await statusRes.json() as any;
    console.log('   Status:', status.status, '| Version:', status.version, '| Model:', status.currentModel);
    console.log('   ✓ Health check passed\n');
  } catch (err: any) {
    console.log('   ✗ Health check failed:', err.message);
    return;
  }
  
  // Test 2: Count golden files
  console.log('2. Testing "count golden files" scenario...');
  const startTime = Date.now();
  try {
    const res = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: "How many files start with 'golden' in my workspace?",
        sessionId: 'test-' + Date.now()
      })
    });
    
    const text = await res.text();
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    
    // Parse SSE events
    const lines = text.split('\n');
    let finalText = '';
    let hasToolCall = false;
    let hasToolResult = false;
    
    for (const line of lines) {
      if (line.startsWith('event: tool_call')) hasToolCall = true;
      if (line.startsWith('event: tool_result')) hasToolResult = true;
      if (line.startsWith('data:') && lines[lines.indexOf(line) - 1]?.includes('final')) {
        try {
          const data = JSON.parse(line.slice(5));
          finalText = data.text;
        } catch {}
      }
    }
    
    // Also try to find final text from 'done' event
    for (let i = 0; i < lines.length; i++) {
      if (lines[i] === 'event: done' && lines[i + 1]?.startsWith('data:')) {
        try {
          const data = JSON.parse(lines[i + 1].slice(5));
          if (data.reply) finalText = data.reply;
        } catch {}
      }
      if (lines[i] === 'event: final' && lines[i + 1]?.startsWith('data:')) {
        try {
          const data = JSON.parse(lines[i + 1].slice(5));
          if (data.text) finalText = data.text;
        } catch {}
      }
    }
    
    console.log(`   Time: ${elapsed}s`);
    console.log('   Tool call detected:', hasToolCall);
    console.log('   Tool result received:', hasToolResult);
    console.log('   Final text:', finalText.slice(0, 200));
    
    if (hasToolCall && hasToolResult) {
      console.log('   ✓ Count golden files test passed\n');
    } else {
      console.log('   ⚠ Test completed but may not have used tools\n');
    }
  } catch (err: any) {
    console.log('   ✗ Test failed:', err.message);
  }
  
  // Test 3: Chat without tools
  console.log('3. Testing conversational chat...');
  const chatStartTime = Date.now();
  try {
    const res = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: "Hey Claw, what's up?",
        sessionId: 'test-chat-' + Date.now()
      })
    });
    
    const text = await res.text();
    const elapsed = ((Date.now() - chatStartTime) / 1000).toFixed(1);
    
    // Parse SSE events
    const lines = text.split('\n');
    let finalText = '';
    let hasToolCall = false;
    
    for (const line of lines) {
      if (line.startsWith('event: tool_call')) hasToolCall = true;
    }
    
    for (let i = 0; i < lines.length; i++) {
      if (lines[i] === 'event: final' && lines[i + 1]?.startsWith('data:')) {
        try {
          const data = JSON.parse(lines[i + 1].slice(5));
          if (data.text) finalText = data.text;
        } catch {}
      }
    }
    
    console.log(`   Time: ${elapsed}s`);
    console.log('   Tool call detected:', hasToolCall);
    console.log('   Response:', finalText.slice(0, 200));
    
    if (!hasToolCall && finalText) {
      console.log('   ✓ Chat test passed (no tools used as expected)\n');
    } else {
      console.log('   ⚠ Chat test completed\n');
    }
  } catch (err: any) {
    console.log('   ✗ Chat test failed:', err.message);
  }
  
  console.log('Tests completed!');
}

runTest().catch(console.error);
