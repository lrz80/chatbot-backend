declare module 'csv-parser' {
  import { Readable } from 'stream';
  interface CsvParserOptions {
    separator?: string;
    mapHeaders?: (args: { header: string; index: number }) => string | null;
    mapValues?: (args: { header: string; index: number; value: string }) => any;
    skipLines?: number;
    headers?: string[] | boolean;
    strict?: boolean;
  }

  function csvParser(options?: CsvParserOptions): NodeJS.ReadWriteStream;

  export = csvParser;
}
