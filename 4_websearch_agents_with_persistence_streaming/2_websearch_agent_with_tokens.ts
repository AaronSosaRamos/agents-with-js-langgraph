import * as dotenv from 'dotenv'
dotenv.config();

import { StateGraph, Annotation, END } from '@langchain/langgraph';
import { ChatOpenAI } from '@langchain/openai';
import { BaseMessage, SystemMessage, HumanMessage, isAIMessageChunk } from '@langchain/core/messages';
import { ToolMessage } from '@langchain/core/messages/tool'
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import { TavilySearchResults } from '@langchain/community/tools/tavily_search';

const tools = [new TavilySearchResults({maxResults: 2})];

// First we define the state
const AgentState = Annotation.Root({
	messages: Annotation<BaseMessage[]>({
		reducer: (x, y) => x.concat(y),
		default: () => []
	})
});

// Now define the memory for persistance
const memory = SqliteSaver.fromConnString(':memory:');

// Now the system prompt
const system = `You are a smart research assistant. Use the search engine to look up information.
You are allowed to make multiple calls (either together or in sequence).
Only look up information when you are sure of what you want.
If you need to look up some information before asking a follow up question, you are allowed to do that!`;

// Now the model we will use
const model = new ChatOpenAI({
	model: 'gpt-4o-mini',
	temperature: 0,
	streaming: true
}).bindTools(tools);

// Here is where we construct the graph
const graph = new StateGraph(AgentState)
	.addNode('llm', callOpenAi)
	.addNode('action', takeAction)
	.addConditionalEdges(
		'llm',
		existsAction,
		{true: 'action', false: END}
	)
	.addEdge('action','llm')
	.setEntryPoint('llm')
	.compile({checkpointer: memory});


// Now lets call the agent with a question
const messages1 = [new HumanMessage('What is the weather in sf?')];

const config1 = {
	streamMode: 'messages' as const, // Specifies we want to see the LLM tokens
	configurable: {thread_id: '4'}, // Used by memory to keep the converstion going
	version: 'v2'
};

const stream = await graph.stream({messages: messages1}, config1);

for await (const [message, _metadata] of stream) {
  if (isAIMessageChunk(message)) {
	  if (message.content) { process.stdout.write(message.content + '|'); }
  }
}



///////// FUNCTIONS USED BY THE GRAPH //////////
// This is the function for the conditional edge
function existsAction(state): any {
	const result = state.messages[state.messages.length-1];

	return result.tool_calls.length > 0;
}

// This is the function for the llm node
async function callOpenAi(state) {
	let messages = state.messages;

	if (system) {
		messages = [new SystemMessage(system), ...messages];
	}

	const message = await model.invoke(messages);
	return {messages: [message]};
}

// This is the function for the action node
async function takeAction(state) {
	const results: ToolMessage[] = [];
	const toolCalls = state.messages[state.messages.length-1].tool_calls;
	let result = '';

	for(const t of toolCalls) {
		console.log('Calling: ' + JSON.stringify(t));
		if (tools.some(tool => tool.name === t.name)) {
			const tool = tools.find(tool => tool.name === t.name);
			result = await tool?.invoke(t.args);
		} else {
			console.log('\n...bad tool name...');
			result = 'bad tool name, retry';
		}
		results.push(new ToolMessage({tool_call_id: t.id, name: t.name, content: result.toString()}));
	}
	console.log('Back to the model!');
	return {messages: results};
}