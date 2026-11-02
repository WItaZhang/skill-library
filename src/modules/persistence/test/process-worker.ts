import pg from 'pg';
import {createPostgresLibraryService} from '../index.ts';
const {connectionString,options,actor,input}=JSON.parse(process.argv[2]);
const pool=new pg.Pool({connectionString,options});
process.send?.('ready');
process.once('message',async()=>{
 try{const version=await createPostgresLibraryService({pool}).publishDraft(actor,input);process.send?.({id:version.id})}
 catch(error){process.send?.({code:(error as any).code})}
 finally{await pool.end();process.disconnect()}
});
